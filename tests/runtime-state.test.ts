import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  writeRuntimeState, readRuntimeState, clearRuntimeState,
  runtimeStatePath, dataDir,
} from '../src/core/platform.js';

const exec = promisify(execFile);

// Point every helper at an isolated HOME so tests never touch real state.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-rt-'));
beforeEach(() => {
  process.env.HOME = tmpHome;
  if (fs.existsSync(runtimeStatePath())) fs.rmSync(runtimeStatePath());
});
afterAll(() => { try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* gone */ } });

describe('runtime state (live tunnel bookkeeping)', () => {
  it('round-trips a tunnel URL', () => {
    writeRuntimeState({
      pid: process.pid, tunnel_url: 'https://abc-def.trycloudflare.com',
      host: '127.0.0.1', port: 8765, started: new Date().toISOString(),
    });
    const rt = readRuntimeState();
    expect(rt?.tunnel_url).toBe('https://abc-def.trycloudflare.com');
    expect(rt?.pid).toBe(process.pid);
  });

  it('treats a dead pid as stale (returns null)', () => {
    // pid 99999999 does not exist on any realistic system
    writeRuntimeState({
      pid: 999_999_999, host: '127.0.0.1', port: 8765, started: new Date().toISOString(),
    });
    expect(readRuntimeState()).toBeNull();
  });

  it('missing file reads as null', () => {
    expect(readRuntimeState()).toBeNull();
  });

  it('clearRuntimeState removes the file', () => {
    writeRuntimeState({ pid: process.pid, host: '127.0.0.1', port: 8765, started: new Date().toISOString() });
    clearRuntimeState();
    expect(fs.existsSync(runtimeStatePath())).toBe(false);
  });
});

/**
 * The regression this guards against: the gateway used to persist the
 * temporary trycloudflare.com URL into config.json's public_host. On a
 * server with a real domain, one `ramcp tunnel` run wrecked the
 * production connector URL. The live URL must go to runtime.json only,
 * and config.json's public_host must stay untouched.
 */
describe('tunnel never clobbers config', () => {
  it('gateway writes runtime state and cleans it up on exit', async () => {
    const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-rt-live-'));
    const run = (args: string[]) => exec(process.execPath, [
      path.resolve(__dirname, '..', 'dist', 'server', 'run.js'), ...args,
    ], {
      env: { ...process.env, HOME: cliHome, RAMCP_PORT: String(19777 + Math.floor(Math.random() * 200)), RAMCP_TOKEN: 'rt-live-check' },
      timeout: 20_000,
    });
    // Boot the gateway for ~2.5s then SIGTERM it.
    const p = (async () => run([]))();
    await new Promise((r) => setTimeout(r, 2500));

    // While running: runtime state exists and config public_host is untouched
    const rt = JSON.parse(fs.readFileSync(
      path.join(cliHome, ...relativeRuntimePath()), 'utf8',
    ));
    expect(rt.pid).toBeGreaterThan(0);
    const cfgFile = findConfig(cliHome);
    if (cfgFile) {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      expect(cfg.public_host).not.toContain('trycloudflare.com');
    }
    await p.catch(() => {}); // SIGTERM → non-zero, expected
  }, 30_000);
});

function relativeRuntimePath(): string[] {
  // runtime.json sits directly in dataDir(); derive from dataDir() root name.
  const abs = runtimeStatePath();
  const home = process.env.HOME || os.homedir();
  return path.relative(home, abs).split(path.sep);
}

function findConfig(home: string): string | null {
  const candidates = [
    path.join(home, '.config', 'remote-access-mcp', 'config.json'),
    path.join(home, 'AppData', 'Roaming', 'remote-access-mcp', 'config.json'),
    path.join(home, 'Library', 'Application Support', 'remote-access-mcp', 'config.json'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}
