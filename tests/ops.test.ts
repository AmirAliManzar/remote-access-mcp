import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type GatewayState } from '../src/server/app.js';

const ADMIN = 'ops-admin-token';

let server: http.Server;
let baseUrl: string;
let state: GatewayState;
let tmpAllowed: string;

beforeAll(async () => {
  tmpAllowed = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-ops-'));
  const { createGatewayState } = await import('../src/server/app.js');
  state = createGatewayState();
  state.cfg = {
    host: '127.0.0.1', port: 0, public_host: '', mcp_path: '/mcp', log_level: 'silent',
    audit: { enabled: false, db_path: '/dev/null' },
    read_only: false,
    tokens: [{
      id: 't1', name: 'admin', token: ADMIN, created: new Date().toISOString(),
      scopes: [], shell_enabled: true, allowed_paths: [tmpAllowed], denied_paths: [],
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

let id = 0;
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${baseUrl}/${ADMIN}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  // Responses are SSE-framed (event: message\ndata: {...}); unwrap the JSON.
  const raw = await res.text();
  const m = raw.match(/data: (.+)$/m);
  const j = JSON.parse(m ? m[1] : raw);
  return j.result;
}

describe('ops tools', () => {
  it('environment_inspect masks secrets', async () => {
    process.env.TEST_SECRET_KEY = 'super-secret-value';
    const r = await call('environment_inspect', {});
    const text = r.content[0].text as string;
    expect(text).toContain('TEST_SECRET_KEY=[MASKED]');
    expect(text).not.toContain('super-secret-value');
    delete process.env.TEST_SECRET_KEY;
  });

  it('nginx_inspect refuses path traversal in site names', async () => {
    const r = await call('nginx_inspect', { site: '../../etc/passwd' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Invalid site name');
  });

  it('nginx_inspect returns a summary (nginx present or file fallback)', async () => {
    const r = await call('nginx_inspect', {});
    const text = r.content[0].text as string;
    // On CI with nginx absent, the fallback lists /etc/nginx paths or reports empty
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});
