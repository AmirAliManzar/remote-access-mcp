import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { buildApp, createGatewayState, type GatewayState } from '../src/server/app.js';

const TOKEN = 'accept-compat-token';

let server: http.Server;
let baseUrl: string;
let state: GatewayState;

beforeAll(async () => {
  state = createGatewayState();
  state.cfg = {
    host: '127.0.0.1', port: 0, public_host: '', mcp_path: '/mcp', log_level: 'silent',
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
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  state.sessions.closeAll();
  await new Promise<void>((r) => server.close(() => r()));
});

const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
});

async function initWith(accept: string) {
  const res = await fetch(`${baseUrl}/${TOKEN}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: accept },
    body: INIT,
  });
  return { status: res.status, sid: res.headers.get('mcp-session-id'), body: await res.text() };
}

/**
 * The MCP spec says POST must accept both application/json and
 * text/event-stream. Real clients don't all comply — Claude's connector in
 * particular got a 406 here, which its UI reports as "Couldn't reach
 * <server>". The gateway widens the header rather than rejecting the
 * handshake, so every client dialect connects.
 */
describe('Accept header tolerance', () => {
  const variants = [
    'application/json, text/event-stream', // ChatGPT / Grok / spec
    'text/event-stream',                   // SSE-only
    'application/json',                    // JSON-only
    '*/*',                                 // permissive
    'application/json;q=0.9, */*;q=0.8',   // weighted
    '',                                    // absent
  ];

  for (const accept of variants) {
    it(`initialize succeeds with Accept: ${accept || '(empty)'}`, async () => {
      const r = await initWith(accept);
      expect(r.status).toBe(200);
      expect(r.body).toContain('serverInfo');
      expect(r.sid).toBeTruthy();
    });
  }

  it('a full handshake works from an SSE-only client', async () => {
    const init = await initWith('text/event-stream');
    const sid = init.sid!;
    const list = await fetch(`${baseUrl}/${TOKEN}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Mcp-Session-Id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain('system_info');
  });
});
