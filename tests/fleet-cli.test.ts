import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CLI tests run against a temp HOME so they never touch real config.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', 'dist', 'main.js');
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-clihome-'));
});

function cli(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: tmpHome, RAMCP_TOKEN: '', DANA_AUTH_TOKEN: '' },
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function cfg(): any {
  return JSON.parse(fs.readFileSync(path.join(tmpHome, '.config', 'remote-access-mcp', 'config.json'), 'utf8'));
}

describe('cli: fleet', () => {
  it('add validates tool groups', () => {
    cli(['init']);
    const bad = cli(['fleet', 'add', '--name', 'web1', '--host', 'root@1.2.3.4', '--tools', 'shell,bogus']);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('Unknown tool group');
  });

  it('refuses a host with zero tools', () => {
    cli(['init']);
    const r = cli(['fleet', 'add', '--name', 'web1', '--host', 'root@1.2.3.4']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('no tools');
  });

  it('add/list/remove lifecycle persists', () => {
    cli(['init']);
    const add = cli(['fleet', 'add', '--name', 'web1', '--host', 'deploy@10.0.0.5', '--port', '2222', '--tools', 'shell,fs', '--note', 'app server']);
    expect(add.code).toBe(0);
    expect(cfg().fleet.hosts).toHaveLength(1);
    const h = cfg().fleet.hosts[0];
    expect(h.name).toBe('web1');
    expect(h.host).toBe('deploy@10.0.0.5');
    expect(h.port).toBe(2222);
    expect(h.tools).toEqual(['shell', 'fs']);

    const list = cli(['fleet', 'list']);
    expect(list.out).toContain('web1');
    expect(list.out).toContain('deploy@10.0.0.5');

    cli(['fleet', 'remove', 'web1']);
    expect(cfg().fleet.hosts).toHaveLength(0);
  });

  it('edit updates tools', () => {
    cli(['init']);
    cli(['fleet', 'add', '--name', 'db1', '--host', 'root@db', '--tools', 'fs']);
    const edit = cli(['fleet', 'edit', 'db1', '--tools', 'fs,logs,services']);
    expect(edit.code).toBe(0);
    expect(cfg().fleet.hosts[0].tools).toEqual(['fs', 'logs', 'services']);
  });
});

describe('cli: webhook', () => {
  it('add/list/off/on/remove lifecycle', () => {
    cli(['init']);
    const add = cli(['webhook', 'add', '--url', 'https://hooks.example.com/ramcp', '--events', 'tool.error,tool.success']);
    expect(add.code).toBe(0);
    expect(cfg().webhooks).toHaveLength(1);
    expect(cfg().webhooks[0].events).toEqual(['tool.error', 'tool.success']);

    const list = cli(['webhook', 'list']);
    expect(list.out).toContain('hooks.example.com');

    cli(['webhook', 'off', 'https://hooks.example.com/ramcp']);
    expect(cfg().webhooks[0].enabled).toBe(false);
    cli(['webhook', 'on', 'https://hooks.example.com/ramcp']);
    expect(cfg().webhooks[0].enabled).toBe(true);

    cli(['webhook', 'remove', 'https://hooks.example.com/ramcp']);
    expect(cfg().webhooks).toHaveLength(0);
  });

  it('validates the URL scheme', () => {
    cli(['init']);
    const r = cli(['webhook', 'add', '--url', 'ftp://nope']);
    expect(r.code).toBe(1);
  });
});

describe('cli: config export/import', () => {
  it('round-trips a full backup and restores it', () => {
    cli(['init']);
    cli(['policy', 'allow', '/tmp']);
    cli(['token', 'add', '--name', 'second', '--shell']);
    cli(['fleet', 'add', '--name', 'web1', '--host', 'root@1.2.3.4', '--tools', 'shell']);
    cli(['webhook', 'add', '--url', 'https://hooks.example.com/x']);

    const exportFile = path.join(tmpHome, 'backup.json');
    const exp = cli(['config', 'export', '--out', exportFile]);
    expect(exp.code).toBe(0);
    const snapshot = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    expect(snapshot.tokens).toHaveLength(2);
    expect(snapshot.fleet.hosts).toHaveLength(1);
    expect(fs.statSync(exportFile).mode & 0o777).toBe(0o600); // tight perms

    // wipe and restore
    fs.rmSync(path.join(tmpHome, '.config', 'remote-access-mcp', 'config.json'));
    const imp = cli(['config', 'import', exportFile]);
    expect(imp.code).toBe(0);
    const restored = cfg();
    expect(restored.tokens).toHaveLength(2);
    expect(restored.fleet.hosts[0].name).toBe('web1');
    expect(restored.tokens.some(t => t.name === 'second' && t.shell_enabled)).toBe(true);
  });

  it('merge preserves local host/port/domain and existing tokens', () => {
    cli(['init']);
    cli(['fleet', 'add', '--name', 'localbox', '--host', 'root@192.168.1.9', '--tools', 'fs']);

    // simulate an export from ANOTHER machine
    const foreign = {
      host: '0.0.0.0', port: 9999, public_host: 'other.example.com',
      mcp_path: '/mcp', log_level: 'info',
      audit: { enabled: true, db_path: '/x/audit.jsonl' }, read_only: false,
      tokens: [{ id: 'f1', name: 'foreign', token: 'foreign-token-xyz', created: '2026-01-01', scopes: [], shell_enabled: false, allowed_paths: [], denied_paths: [] }],
      fleet: { hosts: [{ name: 'web9', host: 'root@5.5.5.5', tools: ['shell'], added: '2026-01-01' }] },
      webhooks: [],
    };
    const f = path.join(tmpHome, 'foreign.json');
    fs.writeFileSync(f, JSON.stringify(foreign));

    const before = cfg();
    const imp = cli(['config', 'import', f, '--merge']);
    expect(imp.code).toBe(0);
    const after = cfg();
    // local identity preserved
    expect(after.host).toBe(before.host);
    expect(after.port).toBe(before.port);
    expect(after.public_host).toBe(before.public_host);
    // both token sets present
    expect(after.tokens.some(t => t.name === 'default')).toBe(true);
    expect(after.tokens.some(t => t.name === 'foreign')).toBe(true);
    // both fleet hosts present
    expect(after.fleet.hosts.some(h => h.name === 'localbox')).toBe(true);
    expect(after.fleet.hosts.some(h => h.name === 'web9')).toBe(true);
  });
});
