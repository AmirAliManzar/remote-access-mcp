import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export type Platform = 'linux' | 'darwin' | 'win32';

export function platform(): Platform {
  const p = process.platform;
  if (p === 'win32' || p === 'darwin' || p === 'linux') return p;
  // Treat other POSIX (freebsd, openbsd…) as linux — same tooling surface.
  return 'linux';
}

export const isWindows = () => platform() === 'win32';
export const isMac = () => platform() === 'darwin';
export const isLinux = () => platform() === 'linux';

/**
 * The shell used by run_command.
 * Windows: PowerShell when available (better quoting, UTF-8), else cmd.exe.
 * POSIX: bash when available, else sh.
 */
export function shellCommand(command: string): { file: string; args: string[] } {
  if (isWindows()) {
    if (which('pwsh')) return { file: 'pwsh', args: ['-NoLogo', '-NonInteractive', '-Command', command] };
    if (which('powershell')) return { file: 'powershell', args: ['-NoLogo', '-NonInteractive', '-Command', command] };
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  if (which('bash')) return { file: 'bash', args: ['-lc', command] };
  return { file: 'sh', args: ['-c', command] };
}

/** Env that keeps child output plain and UTF-8 across platforms. */
export function childEnv(): NodeJS.ProcessEnv {
  return isWindows()
    ? { ...process.env, TERM: 'dumb' }
    : { ...process.env, TERM: 'dumb', LANG: process.env.LANG || 'C.UTF-8' };
}

const whichCache = new Map<string, string | null>();

/** Locate an executable on PATH. Cached. Cross-platform (where.exe / which). */
export function which(bin: string): string | null {
  if (whichCache.has(bin)) return whichCache.get(bin)!;
  let found: string | null = null;
  try {
    const finder = isWindows() ? 'where' : 'which';
    const out = execFileSync(finder, [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    found = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || null;
  } catch {
    found = null;
  }
  whichCache.set(bin, found);
  return found;
}

/** Where per-user data (config, audit, tunnel binary) lives on this OS. */
export function dataDir(): string {
  if (isWindows()) {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'remote-access-mcp');
  }
  if (isMac()) {
    return path.join(os.homedir(), 'Library', 'Application Support', 'remote-access-mcp');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'remote-access-mcp');
}

/**
 * Legacy Linux/mac location (~/.config/remote-access-mcp) used by v1/v2.
 * loadConfig() migrates from here to dataDir() on first run.
 */
export function legacyDataDir(): string {
  return path.join(os.homedir(), '.config', 'remote-access-mcp');
}

/** Path separators/casing differ — normalize for policy comparisons. */
export function normalizePathForCompare(p: string): string {
  const resolved = path.resolve(p);
  // Windows and macOS default to case-insensitive filesystems.
  const cased = (isWindows() || isMac()) ? resolved.toLowerCase() : resolved;
  return isWindows() ? cased.replace(/\\/g, '/') : cased;
}

/** Does this platform have systemd (service install target)? */
export function hasSystemd(): boolean {
  return isLinux() && fs.existsSync('/run/systemd/system');
}

/** Human label for banners and `ramcp doctor`. */
export function platformLabel(): string {
  return `${platform()} ${os.release()} (${os.arch()})`;
}
