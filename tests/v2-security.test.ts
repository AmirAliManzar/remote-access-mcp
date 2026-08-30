import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type GatewayState } from '../src/server/app.js';

const ADMIN = 'admin-token-full-access';
const LIMITED = 'limited-token-x';
const RO = 'readonly-token-y';

let server: http.Server;
let baseUrl: string;
let state: GatewayState;
let tmpAllowed: string;

// Hermetic config: build tokens directly in config, no env needed
beforeAll(() => {
  tmpAllowed = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-allow-'));
  // Point home at a temp dir so we never touch the real config
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-home-'));
  process.env.HOME = tmpHome;
  // The config module computed CONFIG_DIR at import — build state manually instead
});

beforeAll(async () => {
  const { createGatewayState } = await import('../src/server/app.js');
  state = createGatewayState();
  // Override the loaded config with our test tokens
  const testDb = path.join(os.tmpdir(), `ramcp-audit-${process.pid}-${Date.now()}.db`);
  state.cfg = {
    host: '127.0.0.1', port: 0, public_host: '', mcp_path: '/mcp',
    log_level: 'silent',
    audit: { enabled: true, db_path: testDb },
    read_only: false,
    tokens: [
      {
        id: 't1', name: 'admin', token: ADMIN, created: new Date().toISOString(),
        scopes: [], shell_enabled: true, allowed_paths: [tmpAllowed], denied_paths: [],
      },
      {
        id: 't2', name: 'limited', token: LIMITED, created: new Date().toISOString(),
        scopes: ['system'], shell_enabled: false, allowed_paths: [], denied_paths: [],
      },
      {
        id: 't3', name: 'ro', token: RO, created: new Date().toISOString(),
        scopes: [], shell_enabled: true, allowed_paths: [tmpAllowed], denied_paths: [], read_only: true,
      },
    ],
  };
  // Point audit at the hermetic DB (was opened against the real config before override)
  const { AuditLog } = await import('../src/core/audit.js');
  state.audit = new AuditLog(testDb);
  const { app } = buildApp(state);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

let rpcId = 0;
async function rpc(token: string, method: string, params: Record<string, unknown>): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params });
  const res = await fetch(`${baseUrl}/${token}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body,
  });
  return { status: res.status, body: await res.text() };
}

function parseSse(text: string): any {
  const m = text.match(/data: (.+)$/m);
  return JSON.parse(m ? m[1] : text);
}

describe('v2 auth & tokens', () => {
  it('accepts each token via URL path', async () => {
    for (const t of [ADMIN, LIMITED, RO]) {
      const r = await rpc(t, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
      expect(r.status).toBe(200);
      expect(r.body).toContain('serverInfo');
    }
  });

  it('rejects expired tokens', async () => {
    state.cfg.tokens.push({
      id: 'texp', name: 'expired', token: 'expired-token-z', created: '2020-01-01',
      expires: '2020-06-01', scopes: [], shell_enabled: false, allowed_paths: [], denied_paths: [],
    });
    const r = await rpc('expired-token-z', 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(r.status).toBe(401);
  });
});

describe('v2 scopes', () => {
  it('allows in-scope tools', async () => {
    const r = await rpc(LIMITED, 'tools/call', { name: 'system_info', arguments: {} });
    const msg = parseSse(r.body);
    expect(msg.result.content[0].text).toContain('hostname');
  });

  it('blocks out-of-scope tools', async () => {
    const r = await rpc(LIMITED, 'tools/call', { name: 'read_file', arguments: { path: '/etc/hostname' } });
    const msg = parseSse(r.body);
    expect(msg.result.isError).toBe(true);
    expect(msg.result.content[0].text).toContain('not permitted');
  });

  it('blocks shell for token without shell_enabled', async () => {
    const r = await rpc(LIMITED, 'tools/call', { name: 'run_command', arguments: { command: 'echo hi' } });
    const msg = parseSse(r.body);
    expect(msg.result.isError).toBe(true);
    expect(msg.result.content[0].text).toContain('disabled');
  });
});

describe('v2 read-only', () => {
  it('refuses mutating tools for read_only token', async () => {
    const target = path.join(tmpAllowed, 'ro-test.txt');
    fs.writeFileSync(target, 'data');
    const r = await rpc(RO, 'tools/call', { name: 'write_file', arguments: { path: target, content: 'new' } });
    const msg = parseSse(r.body);
    expect(msg.result.isError).toBe(true);
    expect(msg.result.content[0].text).toContain('read-only');
  });

  it('allows read tools for read_only token', async () => {
    const target = path.join(tmpAllowed, 'ro-test.txt');
    const r = await rpc(RO, 'tools/call', { name: 'read_file', arguments: { path: target } });
    const msg = parseSse(r.body);
    expect(msg.result.content[0].text).toBe('data');
  });
});

describe('v2 audit log', () => {
  it('records tool invocations with hash chain intact', async () => {
    await rpc(ADMIN, 'tools/call', { name: 'system_info', arguments: {} });
    const audit = state.audit!;
    const rows = audit.query({ limit: 10 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(r => r.tool === 'system_info')).toBe(true);
    // Redaction: secrets in args are masked
    expect(audit.verify()).toBeNull();
  });
});

describe('v2 SSRF guards', () => {
  it('refuses http_request to loopback', async () => {
    const r = await rpc(ADMIN, 'tools/call', { name: 'http_request', arguments: { url: 'http://127.0.0.1:8765/health' } });
    const msg = parseSse(r.body);
    expect(msg.result.isError).toBe(true);
    expect(msg.result.content[0].text).toContain('internal/private host');
  });

  it('refuses web_fetch to cloud metadata', async () => {
    const r = await rpc(ADMIN, 'tools/call', { name: 'web_fetch', arguments: { url: 'http://169.254.169.254/latest/meta-data' } });
    const msg = parseSse(r.body);
    expect(msg.result.isError).toBe(true);
    expect(msg.result.content[0].text).toContain('internal/private host');
  });

  it('refuses port_check on private ranges', async () => {
    const r = await rpc(ADMIN, 'tools/call', { name: 'port_check', arguments: { host: '192.168.1.1', port: 80 } });
    const msg = parseSse(r.body);
    expect(msg.result.isError).toBe(true);
  });
});

describe('v2 git arg validation', () => {
  it('rejects forbidden git verbs (option injection)', async () => {
    const r = await rpc(ADMIN, 'tools/call', { name: 'git', arguments: { repo_path: tmpAllowed, args: ['--upload-pack=evil', 'status'] } });
    const msg = parseSse(r.body);
    expect(msg.result.isError).toBe(true);
    expect(msg.result.content[0].text).toContain('not allowed');
  });

  it('rejects shell metacharacters in git args', async () => {
    const r = await rpc(ADMIN, 'tools/call', { name: 'git', arguments: { repo_path: tmpAllowed, args: ['log', '--oneline;rm -rf /'] } });
    const msg = parseSse(r.body);
    expect(msg.result.isError).toBe(true);
    expect(msg.result.content[0].text).toContain('rejected');
  });
});

describe('v2 sqlite validation', () => {
  it('rejects ATTACH (sandbox escape)', async () => {
    const db = path.join(tmpAllowed, 't.db');
    fs.writeFileSync(db, Buffer.from('SQLite format 3\0', 'utf8'));
    const r = await rpc(ADMIN, 'tools/call', { name: 'sqlite_query', arguments: { db_path: db, sql: "ATTACH DATABASE '/etc/x' AS x" } });
    const msg = parseSse(r.body);
    expect(msg.result.isError).toBe(true);
    expect(msg.result.content[0].text).toContain('rejected');
  });
});

describe('v2 kill_process guardrail', () => {
  it('refuses to kill the gateway itself', async () => {
    const r = await rpc(ADMIN, 'tools/call', { name: 'kill_process', arguments: { pid: process.pid } });
    const msg = parseSse(r.body);
    expect(msg.result.isError).toBe(true);
    expect(msg.result.content[0].text).toContain('protected');
  });
});
