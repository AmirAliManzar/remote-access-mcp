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

describe('cli', () => {
  it('version prints from package.json', () => {
    const r = cli(['version']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('init creates config + token, second init is a no-op', () => {
    const r1 = cli(['init']);
    expect(r1.code).toBe(0);
    const cfgPath = path.join(tmpHome, '.config', 'remote-access-mcp', 'config.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(Array.isArray(cfg.tokens)).toBe(true);
    expect(cfg.tokens.length).toBe(1);
    expect(cfg.tokens[0].name).toBe('default');
    const token = cfg.tokens[0].token;
    expect(token.length).toBeGreaterThan(20);

    // re-run: no new tokens
    const r2 = cli(['init']);
    expect(r2.code).toBe(0);
    expect(r2.out).toContain('nothing to do');
    const cfg2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(cfg2.tokens.length).toBe(1);
  });

  it('token add/list/rotate/revoke lifecycle', () => {
    cli(['init']);
    const add = cli(['token', 'add', '--name', 'ci', '--shell', '--paths', '/tmp', '--rpm', '30']);
    expect(add.code).toBe(0);
    expect(add.out).toContain('Token "ci" created');

    const list = cli(['token', 'list', '--json']);
    const parsed = JSON.parse(list.out);
    expect(parsed.length).toBe(2);
    const ci = parsed.find((t: any) => t.name === 'ci');
    expect(ci.shell).toBe(true);
    expect(ci.fingerprint).toHaveLength(16);

    const rot = cli(['token', 'rotate', 'ci']);
    expect(rot.out).toContain('rotated');

    const rev = cli(['token', 'revoke', 'ci']);
    expect(rev.code).toBe(0);
    expect(rev.out).toContain('revoked');
    const list2 = cli(['token', 'list', '--json']);
    expect(JSON.parse(list2.out).length).toBe(1);
  });

  it('refuses revoking the last token', () => {
    cli(['init']);
    const r = cli(['token', 'revoke', 'default']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Cannot revoke the last token');
  });

  it('policy allow/deny persist to config', () => {
    cli(['init']);
    cli(['policy', 'allow', '/tmp']);
    cli(['policy', 'deny', '/tmp/private']);
    const show = cli(['policy']);
    expect(show.out).toContain('allowed');
    expect(show.out).toContain('/tmp');
    expect(show.out).toContain('denied');
    expect(show.out).toContain('/tmp/private');
  });

  it('policy readonly toggles global switch', () => {
    cli(['init']);
    cli(['policy', 'readonly', 'on']);
    const show = cli(['status']);
    expect(show.out).toMatch(/read_only:\s+on/);
    cli(['policy', 'readonly', 'off']);
    const show2 = cli(['status']);
    expect(show2.out).toMatch(/read_only:\s+off/);
  });

  it('url prints connector URL with public host', () => {
    cli(['init']);
    const cfgPath = path.join(tmpHome, '.config', 'remote-access-mcp', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.public_host = 'mcp.example.com';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const r = cli(['url']);
    expect(r.out).toContain('https://mcp.example.com/');
    expect(r.out).toContain('/mcp');
  });
});
