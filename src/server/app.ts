import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadLiveConfig, resolveToken, configPath, type RamcpConfig, type TokenRecord } from '../core/config.js';
import { ConfigWatcher, type ToolContext } from '../core/context.js';
import { AuditLog, redactArgs } from '../core/audit.js';
import { RateLimiter } from '../core/rate-limit.js';
import { tokensMatch } from '../core/crypto.js';
import { registerAllTools } from '../tools/index.js';
import { startScheduler } from '../tools/schedule.js';
import { SessionStore } from './sessions.js';
import { LegacySseStore } from './legacy-sse.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

export interface GatewayState {
  cfg: RamcpConfig;
  watcher: ConfigWatcher;
  audit: AuditLog | null;
  limiter: RateLimiter;
  sessions: SessionStore;
  legacySse: LegacySseStore;
  reload(): void;
}

export function createGatewayState(): GatewayState {
  const cfg = loadLiveConfig();
  const watcher = new ConfigWatcher(configPath());
  const audit = cfg.audit.enabled ? new AuditLog(cfg.audit.db_path) : null;
  const limiter = new RateLimiter(120, 2); // 120 burst, 2/sec refill per token

  const state: GatewayState = {
    cfg, watcher, audit, limiter,
    sessions: new SessionStore(),
    legacySse: new LegacySseStore(),
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

  /**
   * Normalize the Accept header for MCP endpoints.
   *
   * The SDK enforces the spec strictly: POST must accept BOTH
   * application/json AND text/event-stream, GET must accept
   * text/event-stream. Real clients are looser — some send only
   * `application/json`, some only `text/event-stream`, some `*​/*`,
   * and Claude's connector (python-httpx) sends a header combination the
   * SDK rejects with 406, which surfaces as "Couldn't reach <server>".
   *
   * A 406 on the very first handshake is never what the operator wants, so
   * we widen the header to the spec-compliant pair and let content
   * negotiation happen where it matters: the response framing.
   */
  function normalizeAccept(req: Request): void {
    const current = String(req.headers.accept || '');
    const wantsJson = current.includes('application/json');
    const wantsSse = current.includes('text/event-stream');
    if (req.method === 'GET') {
      if (!wantsSse) req.headers.accept = 'text/event-stream';
      return;
    }
    if (!wantsJson || !wantsSse) {
      req.headers.accept = 'application/json, text/event-stream';
    }
  }

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

  // ---- MCP handler ------------------------------------------------------------------
  /**
   * Build a fully-wired McpServer for one token. Tools are registered fresh so
   * policy edits (CLI or in-chat) take effect on the next server build.
   */
  function buildServerFor(token: TokenRecord): McpServer {
    const server = new McpServer(
      { name: PKG.name, version: PKG.version },
      { capabilities: { tools: { listChanged: true } } },
    );

    const ctx: ToolContext = {
      cfg: gw.cfg,
      token,
      readOnly: Boolean(gw.cfg.read_only || token.read_only),
      persist: () => { /* config object is shared; saveConfig handles the file */ },
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
    return server;
  }

  /**
   * Serves both client dialects:
   *
   *  - Stateless (ChatGPT, Grok): every POST is self-contained and the
   *    Mcp-Session-Id header is ignored. A throwaway transport per request.
   *  - Stateful (Claude): `initialize` must return an Mcp-Session-Id, and
   *    follow-up requests carry it. Claude aborts the connector with
   *    "Couldn't reach <server>" when the header is missing, so initialize
   *    always opens a real session and we route by id afterwards.
   */
  async function handleMcp(req: Request, res: Response, token: TokenRecord): Promise<void> {
    if (rateLimited(token)) {
      res.status(429).json({ error: 'Too Many Requests' });
      return;
    }
    normalizeAccept(req);
    gw.sessions.sweep();

    const sessionId = req.headers['mcp-session-id'];
    const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;
    const tokenId = AuditLog.fingerprint(token.token);

    // --- existing session: route to its transport ---
    if (sid) {
      const session = gw.sessions.get(sid);
      if (session) {
        if (session.tokenId !== tokenId) {
          // Sessions are bound to the token that opened them.
          res.status(403).json({ jsonrpc: '2.0', error: { code: -32003, message: 'Session belongs to a different token' }, id: null });
          return;
        }
        if (req.method === 'DELETE') {
          gw.sessions.delete(sid);
          res.status(204).end();
          return;
        }
        await session.transport.handleRequest(req, res, req.body);
        return;
      }
      // Unknown/expired id — tell the client to start over instead of hanging.
      res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
      return;
    }

    // --- initialize without a session: open a stateful one ---
    if (req.method === 'POST' && isInitializeRequest(req.body)) {
      const server = buildServerFor(token);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => gw.sessions.newId(),
        enableJsonResponse: false,
        onsessioninitialized: (id: string) => {
          gw.sessions.set({ id, server, transport, tokenId, created: Date.now(), lastSeen: Date.now() });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) gw.sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // --- stateless fallback: self-contained request, throwaway transport ---
    const server = buildServerFor(token);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: false,
    });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  /**
   * Legacy SSE transport (MCP 2024-11-05).
   *
   * A GET on the endpoint opens a long-lived event stream and announces the
   * POST-back URL via `event: endpoint`. Claude's connector picks this
   * transport automatically whenever the URL ends in `/sse`, so the endpoint
   * must answer GET with a stream instead of Streamable HTTP semantics.
   */
  async function handleLegacySseOpen(req: Request, res: Response, token: TokenRecord, basePath: string): Promise<void> {
    if (rateLimited(token)) {
      res.status(429).json({ error: 'Too Many Requests' });
      return;
    }
    const tokenId = AuditLog.fingerprint(token.token);
    // POST-back path lives beside the stream path so the token stays in the URL.
    const messagesPath = `${basePath}/messages`;

    const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
    const server = buildServerFor(token);
    const transport = new SSEServerTransport(messagesPath, res);

    transport.onclose = () => gw.legacySse.delete(transport.sessionId);
    res.on('close', () => gw.legacySse.delete(transport.sessionId));

    await server.connect(transport); // connect() calls start(), writing the SSE head
    gw.legacySse.add({ id: transport.sessionId, server, transport, tokenId, created: Date.now() }, res);
  }

  /** POST-back leg of the legacy transport: /<token>/<path>/messages?sessionId=… */
  async function handleLegacySseMessage(req: Request, res: Response, token: TokenRecord): Promise<void> {
    if (rateLimited(token)) {
      res.status(429).json({ error: 'Too Many Requests' });
      return;
    }
    const raw = req.query.sessionId;
    const sid = Array.isArray(raw) ? String(raw[0]) : (raw ? String(raw) : '');
    if (!sid) {
      res.status(400).json({ error: 'sessionId query parameter required' });
      return;
    }
    const session = gw.legacySse.get(sid);
    if (!session) {
      res.status(404).json({ error: 'Session not found — reopen the SSE stream' });
      return;
    }
    if (session.tokenId !== AuditLog.fingerprint(token.token)) {
      res.status(403).json({ error: 'Session belongs to a different token' });
      return;
    }
    await session.transport.handlePostMessage(req, res, req.body);
  }

  // ---- routes ---------------------------------------------------------------------------
  // Route paths may contain regex specials (e.g. /sse) — escape them.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bare = (p: string) => esc(p.replace(/^\//, ''));

  const registerMcpRoutes = (mcpPath: string): void => {
    const clean = mcpPath.replace(/\/+$/, '');

    // --- legacy SSE POST-back leg (must be registered before the catch-alls) ---
    app.post(`/${bare(clean)}/messages`, async (req, res, next) => {
      try {
        const token = authenticate(tokenFromAuthHeader(req));
        if (!token) return unauthorized(res);
        await handleLegacySseMessage(req, res, token);
      } catch (e) { next(e); }
    });
    app.post(`/:token${esc(clean)}/messages`, async (req, res, next) => {
      try {
        const token = authenticate(req.params.token);
        if (!token) return unauthorized(res);
        await handleLegacySseMessage(req, res, token);
      } catch (e) { next(e); }
    });

    // --- GET: session-aware dispatch ------------------------------------------------
    // A GET with an Mcp-Session-Id header is a Streamable HTTP client opening
    // its server→client notification stream — route it to that session's
    // transport. A GET WITHOUT the id is a legacy-SSE client (Claude picks
    // this automatically for /sse URLs) starting the 2024-11-05 handshake.
    // Mixing these up poisons the streamable client: it would receive the
    // legacy `event: endpoint` frame, log "Unknown SSE event: endpoint",
    // and abort the whole TaskGroup.
    app.get(`/${bare(clean)}`, async (req, res, next) => {
      try {
        const token = authenticate(tokenFromAuthHeader(req));
        if (!token) return unauthorized(res);
        if (req.headers['mcp-session-id']) {
          await handleMcp(req, res, token);
        } else {
          await handleLegacySseOpen(req, res, token, clean);
        }
      } catch (e) { next(e); }
    });
    app.get(`/:token${esc(clean)}`, async (req, res, next) => {
      try {
        const token = authenticate(req.params.token);
        if (!token) return unauthorized(res);
        if (req.headers['mcp-session-id']) {
          await handleMcp(req, res, token);
        } else {
          await handleLegacySseOpen(req, res, token, `/${req.params.token}${clean}`);
        }
      } catch (e) { next(e); }
    });

    app.all(`/${bare(clean)}`, async (req, res, next) => {
      try {
        const token = authenticate(tokenFromAuthHeader(req));
        if (!token) return unauthorized(res);
        await handleMcp(req, res, token);
      } catch (e) { next(e); }
    });
    // token-in-path route: /<token><mcpPath> (ChatGPT-style)
    app.all(`/:token${esc(clean)}`, async (req, res, next) => {
      try {
        const token = authenticate(req.params.token);
        if (!token) return unauthorized(res);
        await handleMcp(req, res, token);
      } catch (e) { next(e); }
    });
  };

  registerMcpRoutes(gw.cfg.mcp_path);
  // Legacy aliases (e.g. /mcp after a move to /sse) — existing connectors keep working.
  for (const alias of gw.cfg.mcp_path_aliases || []) registerMcpRoutes(alias);

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
