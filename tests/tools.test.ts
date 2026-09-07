import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type GatewayState } from '../src/server/app.js';

const TEST_TOKEN = 'test-token-tools456';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  // Hermetic: build the gateway state explicitly — never read the host's
  // real config (the production server may run with a different mcp_path).
  const { createGatewayState } = await import('../src/server/app.js');
  const state: GatewayState = createGatewayState();
  const tmpAllowed = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-tools-'));
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
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

let rpcId = 0;
async function rpc(method: string, params: Record<string, unknown>): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params });
  const res = await fetch(`${baseUrl}/${TEST_TOKEN}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body,
  });
  return { status: res.status, body: await res.text() };
}

function parseSse(text: string): any {
  // Response may be SSE-framed: "event: message\ndata: {...}" or plain JSON (enableJsonResponse)
  const m = text.match(/data: (.+)$/m);
  return JSON.parse(m ? m[1] : text);
}

describe('tools over MCP', () => {
  it('initialize handshake', async () => {
    const r = await rpc('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(r.status).toBe(200);
    const msg = parseSse(r.body);
    expect(msg.result.serverInfo.name).toBe('remote-access-mcp');
  });

  it('lists tools', async () => {
    const r = await rpc('tools/list', {});
    expect(r.status).toBe(200);
    const msg = parseSse(r.body);
    const names = msg.result.tools.map((t: any) => t.name);
    for (const expected of ['system_info', 'read_file', 'write_file', 'run_command', 'http_request', 'git', 'sqlite_query', 'allow_path', 'context_stats', 'context_memory', 'context_snapshot', 'context_diff', 'context_budget', 'context_clear']) {
      expect(names).toContain(expected);
    }
  });

  it('runs system_info', async () => {
    const r = await rpc('tools/call', { name: 'system_info', arguments: {} });
    expect(r.status).toBe(200);
    const msg = parseSse(r.body);
    expect(msg.result.content[0].text).toContain('hostname:');
  });

  it('uses token-isolated context memory and reports cache activity', async () => {
    const first = await rpc('tools/call', { name: 'system_info', arguments: {} });
    expect(parseSse(first.body).result.content[0].text).toContain('hostname:');
    const second = await rpc('tools/call', { name: 'system_info', arguments: {} });
    expect(parseSse(second.body).result.content[0].text).toContain('hostname:');
    const stats = parseSse((await rpc('tools/call', { name: 'context_stats', arguments: {} })).body);
    expect(stats.result.content[0].text).toContain('cacheHits');
    expect(JSON.parse(stats.result.content[0].text).cacheHits).toBeGreaterThanOrEqual(1);
    const memory = parseSse((await rpc('tools/call', { name: 'context_memory', arguments: { limit: 4 } })).body);
    expect(JSON.parse(memory.result.content[0].text).length).toBeGreaterThan(0);
  });


  it('reduces tools/list for scoped tokens while retaining capability discovery', async () => {
    const previousExposure = process.env.RAMCP_TOOL_EXPOSURE;
    process.env.RAMCP_TOOL_EXPOSURE = 'scoped';
    const { createGatewayState } = await import('../src/server/app.js');
    const state = createGatewayState();
    state.cfg = {
      host: '127.0.0.1', port: 0, public_host: '', mcp_path: '/mcp', log_level: 'silent',
      audit: { enabled: false, db_path: '/dev/null' }, read_only: false,
      tokens: [{ id: 'scoped', name: 'scoped', token: 'scoped-token-tools', created: new Date().toISOString(), scopes: ['filesystem'], shell_enabled: false, allowed_paths: [], denied_paths: [] }],
    };
    state.audit = null;
    const { app } = buildApp(state);
    const local = http.createServer(app);
    await new Promise<void>(r => local.listen(0, '127.0.0.1', r));
    try {
      const port = (local.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/scoped-token-tools/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }) });
      const msg = parseSse(await res.text());
      const names = msg.result.tools.map((t: any) => t.name);
      expect(names).toContain('read_file');
      expect(names).toContain('capability_discover');
      expect(names).toContain('capability_batch');
      expect(names).not.toContain('run_command');
      expect(names).not.toContain('package_install');
    } finally {
      if (previousExposure === undefined) delete process.env.RAMCP_TOOL_EXPOSURE; else process.env.RAMCP_TOOL_EXPOSURE = previousExposure;
      await new Promise<void>(r => local.close(() => r()));
    }
  });

  it('batches independent read-only calls and rejects mutation', async () => {
    const batch = await rpc('tools/call', {
      name: 'capability_batch',
      arguments: { calls: [{ name: 'system_info', arguments: {} }, { name: 'system_resource', arguments: {} }] },
    });
    const batchMsg = parseSse(batch.body);
    expect(batchMsg.result.isError).not.toBe(true);
    const payload = JSON.parse(batchMsg.result.content[0].text);
    expect(payload.results).toHaveLength(2);
    expect(payload.results.every((x: any) => x.ok)).toBe(true);

    const denied = await rpc('tools/call', {
      name: 'capability_batch',
      arguments: { calls: [{ name: 'run_command', arguments: { command: 'echo blocked' } }] },
    });
    expect(parseSse(denied.body).result.isError).toBe(true);
    expect(parseSse(denied.body).result.content[0].text).toContain('read-only calls only');
  });

  it('refuses filesystem access when policy is empty', async () => {
    const r = await rpc('tools/call', { name: 'read_file', arguments: { path: '/etc/hostname' } });
    const msg = parseSse(r.body);
    expect(msg.result.isError).toBe(true);
    expect(msg.result.content[0].text).toContain('not allowed');
  });

  it('refuses shell when disabled', async () => {
    const r = await rpc('tools/call', { name: 'run_command', arguments: { command: 'echo hi' } });
    const msg = parseSse(r.body);
    expect(msg.result.isError).toBe(true);
    expect(msg.result.content[0].text).toContain('disabled');
  });

  it('health endpoint works', async () => {
    const res = await fetch(baseUrl + '/health');
    expect(res.status).toBe(200);
  });
});
