import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type GatewayState } from '../src/server/app.js';

const TEST_TOKEN = 'alias-test-token';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const { createGatewayState } = await import('../src/server/app.js');
  const state: GatewayState = createGatewayState();
  state.cfg = {
    host: '127.0.0.1', port: 0, public_host: '', mcp_path: '/sse',
    mcp_path_aliases: ['/mcp'],
    log_level: 'silent',
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
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
});
const HEADERS = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };

describe('mcp_path aliases (legacy connector support)', () => {
  it('primary /sse works with token in path', async () => {
    const res = await fetch(`${baseUrl}/${TEST_TOKEN}/sse`, { method: 'POST', headers: HEADERS, body: INIT });
    expect(res.status).toBe(200);
    expect((await res.text())).toContain('serverInfo');
  });

  it('legacy alias /mcp still works with token in path', async () => {
    const res = await fetch(`${baseUrl}/${TEST_TOKEN}/mcp`, { method: 'POST', headers: HEADERS, body: INIT });
    expect(res.status).toBe(200);
    expect((await res.text())).toContain('serverInfo');
  });

  it('primary /sse works with Bearer header', async () => {
    const res = await fetch(`${baseUrl}/sse`, {
      method: 'POST',
      headers: { ...HEADERS, Authorization: `Bearer ${TEST_TOKEN}` },
      body: INIT,
    });
    expect(res.status).toBe(200);
  });

  it('legacy alias /mcp works with Bearer header', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...HEADERS, Authorization: `Bearer ${TEST_TOKEN}` },
      body: INIT,
    });
    expect(res.status).toBe(200);
  });

  it('unknown path still 404s', async () => {
    const res = await fetch(`${baseUrl}/${TEST_TOKEN}/nope`, { method: 'POST', headers: HEADERS, body: INIT });
    expect(res.status).toBe(404);
  });
});
