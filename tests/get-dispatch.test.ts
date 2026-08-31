import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { buildApp, createGatewayState, type GatewayState } from '../src/server/app.js';

const TOKEN = 'mixed-transport-token';

let server: http.Server;
let port: number;
let state: GatewayState;

beforeAll(async () => {
  state = createGatewayState();
  state.cfg = {
    host: '127.0.0.1', port: 0, public_host: '', mcp_path: '/sse',
    mcp_path_aliases: ['/mcp'],
    log_level: 'silent',
    audit: { enabled: false, db_path: '/dev/null' },
    read_only: false,
    tokens: [{
      id: 'a', name: 'a', token: TOKEN, created: new Date().toISOString(),
      scopes: [], shell_enabled: false, allowed_paths: [], denied_paths: [],
    }],
  };
  state.audit = null;
  const { app } = buildApp(state);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  state.legacySse.closeAll();
  state.sessions.closeAll();
  await new Promise<void>((r) => server.close(() => r()));
});

const H = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; sid: string | null; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { ...H, ...headers } },
      (res) => {
        let d = '';
        res.on('data', (c) => { d += c; if (d.includes('\n\n')) { res.destroy(); } });
        res.on('end', () => resolve({ status: res.statusCode!, sid: res.headers['mcp-session-id'] ?? null, body: d }));
      },
    );
    r.on('error', reject);
    r.write(JSON.stringify(body));
    r.end();
  });
}

function get(path: string, headers: Record<string, string> = {}, ms = 4000): Promise<{ status: number; frames: string[] }> {
  return new Promise((resolve) => {
    const frames: string[] = [];
    const r = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Accept: 'text/event-stream', ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString();
          let i: number;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            frames.push(buf.slice(0, i));
            buf = buf.slice(i + 2);
          }
          if (frames.some(f => f.includes('event: endpoint'))) { r.destroy(); resolve({ status: res.statusCode!, frames }); }
        });
        res.on('end', () => resolve({ status: res.statusCode!, frames }));
      },
    );
    r.on('error', () => resolve({ status: 0, frames }));
    r.setTimeout(ms, () => { r.destroy(); resolve({ status: -1, frames }); });
    r.end();
  });
}

const INIT = {
  jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
};

/**
 * The bug this pins: a Streamable HTTP client that opens its GET notification
 * stream (with Mcp-Session-Id) must get the streamable stream — NOT the legacy
 * `event: endpoint` frame, which makes modern clients abort with
 * "Unknown SSE event: endpoint" (this is what killed Claude's connector).
 * A GET without the id is a legacy client and must still get the endpoint.
 */
describe('GET disambiguation by Mcp-Session-Id', () => {
  it('GET WITH session id → streamable notification stream, never an endpoint frame', async () => {
    const init = await post('/sse', INIT, { Authorization: `Bearer ${TOKEN}` });
    expect(init.status).toBe(200);
    const sid = init.sid!;
    expect(sid).toBeTruthy();

    const g = await get('/sse', { 'Mcp-Session-Id': sid, Authorization: `Bearer ${TOKEN}` }, 2500);
    // A notification stream with nothing to say simply hangs open (status -1
    // from our helper's timeout) — the key assertion is that NO legacy
    // endpoint frame ever appears on it.
    expect([200, -1]).toContain(g.status);
    expect(g.frames.some(f => f.includes('event: endpoint'))).toBe(false);
  });

  it('GET WITHOUT session id → legacy handshake with endpoint frame', async () => {
    const g = await get(`/${TOKEN}/sse`);
    expect(g.status).toBe(200);
    expect(g.frames.some(f => f.includes('event: endpoint'))).toBe(true);
  });

  it('both transports work on the /mcp alias too', async () => {
    // legacy
    const legacy = await get(`/${TOKEN}/mcp`);
    expect(legacy.frames.some(f => f.includes('event: endpoint'))).toBe(true);
    // streamable
    const init = await post('/mcp', INIT, { Authorization: `Bearer ${TOKEN}` });
    expect(init.status).toBe(200);
    const g = await get('/mcp', { 'Mcp-Session-Id': init.sid!, Authorization: `Bearer ${TOKEN}` });
    expect(g.frames.some(f => f.includes('event: endpoint'))).toBe(false);
  });
});
