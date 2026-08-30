import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, type RamcpConfig } from '../core/config.js';
import { registerAllTools } from '../tools/index.js';
import type { PolicyConfig } from '../core/policy.js';

export function buildApp(): { app: express.Express; cfg: RamcpConfig } {
  const cfg = loadConfig();
  const policy: PolicyConfig = {
    allowed_paths: cfg.allowed_paths,
    denied_paths: cfg.denied_paths,
    shell_enabled: cfg.shell_enabled,
  };

  const app = express();

  // JSON bodies only. The MCP transport accepts a pre-parsed object —
  // raw Buffers confuse it (it treats the Buffer itself as the message).
  app.use(express.json({ limit: '64mb' }));

  // ---- helpers --------------------------------------------------------------
  function unauthorized(res: Response, msg = 'Unauthorized'): void {
    res.status(401).json({ error: msg });
  }

  function tokenFromAuthHeader(req: Request): string | null {
    const h = req.headers.authorization;
    if (!h) return null;
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1] : null;
  }

  // ---- health ----------------------------------------------------------------
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'remote-access-mcp', version: '1.0.0' });
  });

  // ---- connector -----------------------------------------------------------------
  app.get('/connector', (req, res) => {
    const token = tokenFromAuthHeader(req);
    if (!token || token !== cfg.token) return unauthorized(res);
    const host = cfg.public_host || `127.0.0.1:${cfg.port}`;
    const scheme = cfg.public_host ? 'https' : 'http';
    res.json({
      title: 'Chatbot Connection Link',
      url: `${scheme}://${host}/${cfg.token}${cfg.mcp_path}`,
    });
  });

  // ---- MCP handler (shared by both routes) ------------------------------------------
  async function handleMcp(req: Request, res: Response): Promise<void> {
    // Fresh server per request (stateless). Tools re-registered each time —
    // policy mutation via tools takes effect on the very next request.
    const server = new McpServer(
      { name: 'remote-access-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    registerAllTools(server, cfg, policy, () => { /* config already persisted by tools */ });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  // ---- canonical route: /mcp (Authorization header) ------------------------------------
  app.all('/mcp', async (req, res, next) => {
    try {
      const token = tokenFromAuthHeader(req);
      if (!token || token !== cfg.token) return unauthorized(res);
      await handleMcp(req, res);
    } catch (e) { next(e); }
  });

  // ---- token-in-path route: /<token>/mcp (ChatGPT-style) ----------------------------------
  app.all('/:token/mcp', async (req, res, next) => {
    try {
      if (req.params.token !== cfg.token) return unauthorized(res);
      await handleMcp(req, res);
    } catch (e) { next(e); }
  });

  // ---- 404 + error -------------------------------------------------------------------
  app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[gateway]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
  });

  return { app, cfg };
}
