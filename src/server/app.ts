import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadLiveConfig, resolveToken, type RamcpConfig, type TokenRecord } from '../core/config.js';
import { ConfigWatcher, type ToolContext } from '../core/context.js';
import { AuditLog, redactArgs } from '../core/audit.js';
import { RateLimiter } from '../core/rate-limit.js';
import { tokensMatch } from '../core/crypto.js';
import { registerAllTools } from '../tools/index.js';
import { startScheduler } from '../tools/schedule.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

export interface GatewayState {
  cfg: RamcpConfig;
  watcher: ConfigWatcher;
  audit: AuditLog | null;
  limiter: RateLimiter;
  reload(): void;
}

export function createGatewayState(): GatewayState {
  const cfg = loadLiveConfig();
  const watcher = new ConfigWatcher(path.join(os.homedir(), '.config', 'remote-access-mcp', 'config.json'));
  const audit = cfg.audit.enabled ? new AuditLog(cfg.audit.db_path) : null;
  const limiter = new RateLimiter(120, 2); // 120 burst, 2/sec refill per token

  const state: GatewayState = {
    cfg, watcher, audit, limiter,
    reload() {
      if (watcher.changed()) {
        state.cfg = loadLiveConfig();
        if (cfg.audit.enabled && !state.audit) state.audit = new AuditLog(state.cfg.audit.db_path);
      }
    },
  };
  return state;
}

export function buildApp(state?: GatewayState): { app: express.Express; cfg: RamcpConfig; state: GatewayState } {
  const gw = state || createGatewayState();

  const app = express();
  app.disable('x-powered-by');
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

  /** Resolve + validate a presented token to its record, or null. */
  function authenticate(presented: string | null): TokenRecord | null {
    if (!presented) return null;
    gw.reload(); // hot-reload config if it changed on disk
    // Fast reject on length before the constant-time compare loop
    const candidates = gw.cfg.tokens.filter(t => t.token.length === presented.length);
    for (const t of candidates) {
      if (tokensMatch(t.token, presented)) {
        if (t.expires && new Date(t.expires).getTime() < Date.now()) return null;
        return t;
      }
    }
    return null;
  }

  function rateLimited(t: TokenRecord): boolean {
    const cap = t.max_requests_per_minute;
    if (!cap) return false;
    // per-minute budget: refill cap/60 per second, burst cap
    const key = AuditLog.fingerprint(t.token);
    return !gw.limiter.allowBurst(key, Math.floor(cap / 4));
  }

  // ---- health ----------------------------------------------------------------
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'remote-access-mcp', version: PKG.version });
  });

  // ---- metrics (Prometheus text format, opt-in via ?token= or Bearer) --------
  app.get('/metrics', (req, res) => {
    const presented = tokenFromAuthHeader(req) || (req.query.token as string) || null;
    const t = authenticate(presented);
    if (!t) return unauthorized(res);
    const uptime = process.uptime();
    const mem = process.memoryUsage().rss;
    const auditRows = gw.audit ? gw.audit.query({ limit: 1000 }).length : 0;
    const body = [
      '# HELP ramcp_up Gateway is running',
      '# TYPE ramcp_up gauge',
      'ramcp_up 1',
      '# HELP ramcp_uptime_seconds Gateway uptime',
      '# TYPE ramcp_uptime_seconds gauge',
      `ramcp_uptime_seconds ${Math.round(uptime)}`,
      '# HELP ramcp_rss_bytes Resident memory',
      '# TYPE ramcp_rss_bytes gauge',
      `ramcp_rss_bytes ${mem}`,
      '# HELP ramcp_tokens Number of configured tokens',
      '# TYPE ramcp_tokens gauge',
      `ramcp_tokens ${gw.cfg.tokens.length}`,
      '# HELP ramcp_audit_rows Audit entries (recent window)',
      '# TYPE ramcp_audit_rows gauge',
      `ramcp_audit_rows ${auditRows}`,
      '# HELP ramcp_read_only Global read-only mode',
      '# TYPE ramcp_read_only gauge',
      `ramcp_read_only ${gw.cfg.read_only ? 1 : 0}`,
    ].join('\n') + '\n';
    res.type('text/plain').send(body);
  });

  // ---- connector -----------------------------------------------------------------
  app.get('/connector', (req, res) => {
    const presented = tokenFromAuthHeader(req);
    const t = authenticate(presented);
    if (!t) return unauthorized(res);
    const host = gw.cfg.public_host || `127.0.0.1:${gw.cfg.port}`;
    const scheme = gw.cfg.public_host ? 'https' : 'http';
    res.json({
      title: 'Chatbot Connection Link',
      url: `${scheme}://${host}/${t.token}${gw.cfg.mcp_path}`,
    });
  });

  // ---- MCP handler (shared by both routes) ------------------------------------------
  async function handleMcp(req: Request, res: Response, token: TokenRecord): Promise<void> {
    if (rateLimited(token)) {
      res.status(429).json({ error: 'Too Many Requests' });
      return;
    }
    if (gw.cfg.read_only || token.read_only) {
      // Read-only tokens still see everything listed; refusals happen per-tool.
    }

    // Fresh server per request (stateless). Tools re-registered each time —
    // policy mutation via tools takes effect on the very next request.
    const server = new McpServer(
      { name: PKG.name, version: PKG.version },
      { capabilities: { tools: { listChanged: true } } },
    );

    const ctx: ToolContext = {
      cfg: gw.cfg,
      token,
      readOnly: Boolean(gw.cfg.read_only || token.read_only),
      persist: () => { /* config object is shared; CLI/saveConfig handles the file */ },
      audit: (tool, args, ok, isError, durationMs) => {
        if (!gw.audit) return;
        try {
          gw.audit.record({
            ts: Date.now(),
            token_fingerprint: AuditLog.fingerprint(token.token),
            tool,
            args_json: redactArgs(args),
            ok: ok ? 1 : 0,
            is_error: isError ? 1 : 0,
            duration_ms: Math.round(durationMs),
          });
        } catch { /* audit must never break the request */ }
      },
    };

    // Wrap every tool handler so audit is recorded without touching each impl
    const origRegister = server.registerTool.bind(server);
    (server as any).registerTool = (name: string, config: any, handler: (args: any) => Promise<any>) => {
      const wrapped = async (args: any) => {
        const started = Date.now();
        let result: any;
        let isError = false;
        try {
          result = await handler(args);
          isError = Boolean(result?.isError);
        } catch (e: any) {
          isError = true;
          result = { content: [{ type: 'text', text: e?.message || 'tool error' }], isError: true };
        }
        ctx.audit(name, args || {}, !isError, isError, Date.now() - started);
        return result;
      };
      return origRegister(name, config, wrapped);
    };

    registerAllTools(server, ctx);

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
      const token = authenticate(tokenFromAuthHeader(req));
      if (!token) return unauthorized(res);
      await handleMcp(req, res, token);
    } catch (e) { next(e); }
  });

  // ---- token-in-path route: /<token>/mcp (ChatGPT-style) ----------------------------------
  app.all('/:token/mcp', async (req, res, next) => {
    try {
      const token = authenticate(req.params.token);
      if (!token) return unauthorized(res);
      await handleMcp(req, res, token);
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

  return { app, cfg: gw.cfg, state: gw };
}

// Back-compat: tests / old callers expect buildApp() with env-only config.
export function buildStandaloneApp() {
  return buildApp();
}
