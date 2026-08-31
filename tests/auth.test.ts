import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { buildApp, type GatewayState } from '../src/server/app.js';

const TEST_TOKEN = 'test-token-abc123';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  // Hermetic: explicit gateway state — never read the host's real config
  // (the production server may run with a different mcp_path).
  const { createGatewayState } = await import('../src/server/app.js');
  const state: GatewayState = createGatewayState();
  state.cfg = {
    host: '127.0.0.1', port: 0, public_host: '', mcp_path: '/mcp', log_level: 'silent',
    audit: { enabled: false, db_path: '/dev/null' },
    read_only: false,
    tokens: [{
      id: 't1', name: 'default', token: TEST_TOKEN, created: new Date().toISOString(),
      scopes: [], shell_enabled: false, allowed_paths: [], denied_paths: [],
    }],
  };
  state.audit = null;
  const { app } = buildApp(state);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
});
const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

async function post(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const res = await fetch(baseUrl + path, { method: 'POST', headers: { ...HEADERS, ...headers }, body: INIT_BODY });
  return { status: res.status, body: await res.text() };
}

describe('gateway auth', () => {
  it('rejects /mcp without a token', async () => {
    const r = await post('/mcp');
    expect(r.status).toBe(401);
  });

  it('rejects /mcp with a wrong token', async () => {
    const r = await post('/mcp', { Authorization: 'Bearer WRONG' });
    expect(r.status).toBe(401);
  });

  it('rejects a wrong token in the URL path', async () => {
    const r = await post('/WRONG/mcp');
    expect(r.status).toBe(401);
  });

  it('serves /health without auth', async () => {
    const res = await fetch(baseUrl + '/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('404s unknown paths', async () => {
    const res = await fetch(baseUrl + '/nope');
    expect(res.status).toBe(404);
  });

  it('accepts /mcp with a valid bearer token', async () => {
    const r = await post('/mcp', { Authorization: `Bearer ${TEST_TOKEN}` });
    expect(r.status).toBe(200);
    expect(r.body).toContain('serverInfo');
  });

  it('accepts /<token>/mcp (ChatGPT-style URL auth)', async () => {
    const r = await post(`/${TEST_TOKEN}/mcp`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('serverInfo');
  });
});
