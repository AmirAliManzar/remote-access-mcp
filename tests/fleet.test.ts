import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, createGatewayState, type GatewayState } from '../src/server/app.js';
import { fleetProbe, sshRun, buildReadCommand, buildWriteCommand, FLEET_CAPABILITIES, isFleetCapability } from '../src/core/fleet.js';

/**
 * Live fleet test against this machine's own SSH (port 8600).
 *
 * The SSH server here runs on a non-standard port with key auth for root,
 * which is exactly the shape a real fleet host has. These tests prove the
 * SSH path end-to-end: command builders → ssh exec → output decode.
 * They are skipped automatically when SSH is unreachable (CI containers,
 * laptops without sshd) so the suite stays green everywhere while still
 * running on any box that has sshd up.
 */
const SSH_PORT = 8600;
const sshReachable = (() => {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-p', String(SSH_PORT), 'root@127.0.0.1', 'echo', 'ok'], { stdio: 'ignore', timeout: 8000 });
    return true;
  } catch { return false; }
})();

describe.skipIf(!sshReachable)('fleet over real SSH (127.0.0.1:8600)', () => {
  const HOST = { name: 'self', host: 'root@127.0.0.1', port: SSH_PORT, tools: ['shell', 'fs', 'logs', 'services', 'packages'], added: 'now' };

  it('probes reachable', async () => {
    const r = await fleetProbe(HOST);
    expect(r.ok).toBe(true);
  });

  it('runs a command and captures output', async () => {
    const { stdout } = await sshRun(HOST.host, HOST.port, 'echo fleet-live-test');
    expect(stdout).toContain('fleet-live-test');
  });

  it('reads a file via base64 round-trip', async () => {
    const tmp = path.join(os.tmpdir(), 'fleet-read-test.txt');
    fs.writeFileSync(tmp, 'hello from fleet');
    const { stdout } = await sshRun(HOST.host, HOST.port, buildReadCommand(tmp));
    const decoded = Buffer.from(stdout.trim(), 'base64').toString('utf8');
    expect(decoded).toBe('hello from fleet');
    fs.unlinkSync(tmp);
  });

  it('writes a file via stdin base64 (no temp files)', async () => {
    const tmp = path.join(os.tmpdir(), 'fleet-write-test', 'deep', 'file.txt');
    const content = 'written over ssh stdin ✅';
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    await sshRun(HOST.host, HOST.port, buildWriteCommand(tmp, content, true), { stdin: b64 });
    expect(fs.readFileSync(tmp, 'utf8')).toBe(content);
    fs.rmSync(path.dirname(path.dirname(tmp)), { recursive: true, force: true });
  });
});

describe('fleet module units', () => {
  it('capability list is exactly the five groups', () => {
    expect([...FLEET_CAPABILITIES]).toEqual(['shell', 'fs', 'services', 'packages', 'logs']);
    expect(isFleetCapability('shell')).toBe(true);
    expect(isFleetCapability('fs')).toBe(true);
    expect(isFleetCapability('sqlite')).toBe(false);
  });
});

/**
 * End-to-end through the MCP transport: a token whose config has a fleet
 * host can call read_file with host=self, and the per-host allowlist is
 * enforced (a host without the fs group refuses).
 */
describe.skipIf(!sshReachable)('fleet tools over MCP', () => {
  const TOKEN = 'fleet-e2e-token';
  let server: http.Server;
  let baseUrl: string;
  let state: GatewayState;

  beforeAll(async () => {
    state = createGatewayState();
    state.cfg = {
      host: '127.0.0.1', port: 0, public_host: '', mcp_path: '/mcp', log_level: 'silent',
      audit: { enabled: false, db_path: '/dev/null' },
      read_only: false,
      fleet: {
        hosts: [
          { name: 'self', host: 'root@127.0.0.1', port: SSH_PORT, tools: ['shell', 'fs'], added: 'now' },
          { name: 'limited', host: 'root@127.0.0.1', port: SSH_PORT, tools: ['shell'], added: 'now' },
        ],
      },
      tokens: [{
        id: 't1', name: 'default', token: TOKEN, created: new Date().toISOString(),
        scopes: [], shell_enabled: true, allowed_paths: [], denied_paths: [],
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

  async function call(name: string, args: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${baseUrl}/${TOKEN}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const raw = await res.text();
    const m = raw.match(/data: (.+)$/m);
    return JSON.parse(m ? m[1] : raw).result;
  }

  it('run_command with host= runs remotely', async () => {
    const r = await call('run_command', { command: 'echo remote-ok && hostname', host: 'self' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('remote-ok');
  });

  it('read_file with host= reads the remote file', async () => {
    const tmp = path.join(os.tmpdir(), 'fleet-mcp-read.txt');
    fs.writeFileSync(tmp, 'fleet-mcp-content');
    const r = await call('read_file', { path: tmp, host: 'self' });
    expect(r.content[0].text).toBe('fleet-mcp-content');
    fs.unlinkSync(tmp);
  });

  it('per-host allowlist is enforced', async () => {
    const r = await call('read_file', { path: '/etc/hostname', host: 'limited' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('does not allow the fs tool group');
  });

  it('unknown host errors clearly', async () => {
    const r = await call('run_command', { command: 'echo x', host: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Unknown fleet host');
  });
});
