import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { buildApp } from '../src/server/app.js';

const TEST_TOKEN = 'test-token-tools456';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.RAMCP_TOKEN = TEST_TOKEN;
  process.env.RAMCP_SHELL = '0';   // hermetic: never inherit the host's real config
  const { app } = buildApp();
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.RAMCP_TOKEN;
  delete process.env.RAMCP_SHELL;
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
    for (const expected of ['system_info', 'read_file', 'write_file', 'run_command', 'http_request', 'git', 'sqlite_query', 'allow_path']) {
      expect(names).toContain(expected);
    }
  });

  it('runs system_info', async () => {
    const r = await rpc('tools/call', { name: 'system_info', arguments: {} });
    expect(r.status).toBe(200);
    const msg = parseSse(r.body);
    expect(msg.result.content[0].text).toContain('hostname:');
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
