import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { buildApp, createGatewayState, type GatewayState } from '../src/server/app.js';

const TOKEN_A = 'session-token-a';
const TOKEN_B = 'session-token-b';

let server: http.Server;
let baseUrl: string;
let state: GatewayState;

beforeAll(async () => {
  state = createGatewayState();
  state.cfg = {
    host: '127.0.0.1', port: 0, public_host: '', mcp_path: '/mcp', log_level: 'silent',
    audit: { enabled: false, db_path: '/dev/null' },
    read_only: false,
    tokens: [
      { id: 'a', name: 'a', token: TOKEN_A, created: new Date().toISOString(), scopes: [], shell_enabled: false, allowed_paths: [], denied_paths: [] },
      { id: 'b', name: 'b', token: TOKEN_B, created: new Date().toISOString(), scopes: [], shell_enabled: false, allowed_paths: [], denied_paths: [] },
    ],
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

const H = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };

async function call(token: string, body: unknown, extraHeaders: Record<string, string> = {}, method = 'POST') {
  const res = await fetch(`${baseUrl}/${token}/mcp`, {
    method,
    headers: { ...H, ...extraHeaders },
    body: method === 'DELETE' ? undefined : JSON.stringify(body),
  });
  return { status: res.status, sid: res.headers.get('mcp-session-id'), body: await res.text() };
}

const INIT = {
  jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } },
};

/**
 * Claude's connector aborts with "Couldn't reach <server>" unless
 * `initialize` hands back an Mcp-Session-Id and later requests routed by
 * that id keep working. ChatGPT/Grok never send the header at all.
 * Both dialects must be served from the same endpoint.
 */
describe('stateful sessions (Claude dialect)', () => {
  it('initialize returns an Mcp-Session-Id', async () => {
    const r = await call(TOKEN_A, INIT);
    expect(r.status).toBe(200);
    expect(r.sid).toBeTruthy();
    expect(r.body).toContain('serverInfo');
  });

  it('routes follow-up requests by session id', async () => {
    const init = await call(TOKEN_A, INIT);
    const sid = init.sid!;
    const notif = await call(TOKEN_A, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'Mcp-Session-Id': sid });
    expect([200, 202]).toContain(notif.status);

    const list = await call(TOKEN_A, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'Mcp-Session-Id': sid });
    expect(list.status).toBe(200);
    expect(list.body).toContain('system_info');

    const callTool = await call(TOKEN_A, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'system_info', arguments: {} } }, { 'Mcp-Session-Id': sid });
    expect(callTool.status).toBe(200);
    expect(callTool.body).toContain('hostname');
  });

  it('unknown session id returns 404 so the client restarts cleanly', async () => {
    const r = await call(TOKEN_A, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'Mcp-Session-Id': 'no-such-session' });
    expect(r.status).toBe(404);
    expect(r.body).toContain('Session not found');
  });

  it('DELETE tears the session down', async () => {
    const init = await call(TOKEN_A, INIT);
    const sid = init.sid!;
    const del = await call(TOKEN_A, null, { 'Mcp-Session-Id': sid }, 'DELETE');
    expect([200, 204]).toContain(del.status);
    // now unusable
    const after = await call(TOKEN_A, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, { 'Mcp-Session-Id': sid });
    expect(after.status).toBe(404);
  });

  it('sessions are bound to the token that opened them', async () => {
    const init = await call(TOKEN_A, INIT);
    const sid = init.sid!;
    const hijack = await call(TOKEN_B, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'Mcp-Session-Id': sid });
    expect(hijack.status).toBe(403);
  });
});

describe('stateless dialect (ChatGPT/Grok) still works', () => {
  it('tools/call without any session header succeeds', async () => {
    const r = await call(TOKEN_A, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'system_info', arguments: {} } });
    expect(r.status).toBe(200);
    expect(r.body).toContain('hostname');
  });

  it('tools/list without any session header succeeds', async () => {
    const r = await call(TOKEN_A, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(r.status).toBe(200);
    expect(r.body).toContain('system_info');
  });
});
