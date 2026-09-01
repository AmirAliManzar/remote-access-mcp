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
    cli(['webhook', 'add', '--url', 'https://hooks.example.com/x']);

    const exportFile = path.join(tmpHome, 'backup.json');
    const exp = cli(['config', 'export', '--out', exportFile]);
    expect(exp.code).toBe(0);
    const snapshot = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    expect(snapshot.tokens).toHaveLength(2);
    expect(snapshot.webhooks).toHaveLength(1);
    expect(fs.statSync(exportFile).mode & 0o777).toBe(0o600); // tight perms

    // wipe and restore
    fs.rmSync(path.join(tmpHome, '.config', 'remote-access-mcp', 'config.json'));
    const imp = cli(['config', 'import', exportFile]);
    expect(imp.code).toBe(0);
    const restored = cfg();
    expect(restored.tokens).toHaveLength(2);
    expect(restored.tokens.some(t => t.name === 'second' && t.shell_enabled)).toBe(true);
  });

  it('merge preserves local host/port/domain and existing entries', () => {
    cli(['init']);

    // simulate an export from ANOTHER machine
    const foreign = {
      host: '0.0.0.0', port: 9999, public_host: 'other.example.com',
      mcp_path: '/mcp', log_level: 'info',
      audit: { enabled: true, db_path: '/x/audit.jsonl' }, read_only: false,
      tokens: [{ id: 'f1', name: 'foreign', token: 'foreign-token-xyz', created: '2026-01-01', scopes: [], shell_enabled: false, allowed_paths: [], denied_paths: [] }],
      webhooks: [{ url: 'https://hooks.example.com/from-foreign', events: ['tool.error'], enabled: true }],
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
    // webhooks unioned
    expect(after.webhooks.some(w => w.url === 'https://hooks.example.com/from-foreign')).toBe(true);
  });
});

/** The fleet command must be fully gone after v3.0 — not hidden, removed. */
describe('cli: fleet is removed', () => {
  it('ramcp fleet rejects as unknown command', () => {
    cli(['init']);
    const r = cli(['fleet', 'list']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Unknown command: fleet');
  });
});
