import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  platform, isWindows, isMac, isLinux, which, dataDir,
  normalizePathForCompare, shellCommand, childEnv, platformLabel,
} from '../src/core/platform.js';
import { isPathAllowed, resolveReal, type PolicyConfig } from '../src/core/policy.js';

describe('platform layer', () => {
  it('reports a supported platform', () => {
    expect(['linux', 'darwin', 'win32']).toContain(platform());
    // Exactly one predicate is true
    expect([isWindows(), isMac(), isLinux()].filter(Boolean).length).toBe(1);
  });

  it('picks a shell appropriate for the platform', () => {
    const { file, args } = shellCommand('echo hi');
    if (isWindows()) {
      expect(['pwsh', 'powershell', 'cmd.exe']).toContain(file);
    } else {
      expect(['bash', 'sh']).toContain(file);
      expect(args).toContain('echo hi');
    }
  });

  it('childEnv disables TTY features', () => {
    expect(childEnv().TERM).toBe('dumb');
  });

  it('which() finds node and returns null for nonsense', () => {
    expect(which('node')).toBeTruthy();
    expect(which('definitely-not-a-real-binary-xyz')).toBeNull();
  });

  it('dataDir lives under the user home', () => {
    expect(dataDir().startsWith(os.homedir())).toBe(true);
    expect(dataDir()).toContain('remote-access-mcp');
  });

  it('platformLabel is human readable', () => {
    expect(platformLabel()).toContain(platform());
  });
});

describe('path comparison across platforms', () => {
  it('normalizes separators to forward slashes on Windows', () => {
    const n = normalizePathForCompare(path.join('a', 'b'));
    expect(n.includes('\\')).toBe(false);
  });

  it('is case-insensitive on Windows/macOS, case-sensitive on Linux', () => {
    const a = normalizePathForCompare('/Tmp/Foo');
    const b = normalizePathForCompare('/tmp/foo');
    if (isWindows() || isMac()) expect(a).toBe(b);
    else expect(a).not.toBe(b);
  });
});

describe('policy engine with platform-aware paths', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-plat-'));
  const sub = path.join(tmp, 'inner');
  fs.mkdirSync(sub, { recursive: true });

  const mk = (allowed: string[], denied: string[] = []): PolicyConfig =>
    ({ allowed_paths: allowed, denied_paths: denied, shell_enabled: false });

  it('allows nested paths using the native separator', () => {
    const p = mk([tmp]);
    expect(isPathAllowed(p, path.join(sub, 'file.txt'))).toBe(true);
  });

  it('still refuses siblings outside the root', () => {
    const p = mk([sub]);
    expect(isPathAllowed(p, path.join(tmp, 'other.txt'))).toBe(false);
  });

  it('resolveReal terminates at a filesystem root for missing paths', () => {
    const missing = path.join(tmp, 'no', 'such', 'deep', 'file.txt');
    const r = resolveReal(missing);
    expect(path.isAbsolute(r)).toBe(true);
    expect(r).toContain('file.txt');
  });

  it('resolveReal does not hang on a nonexistent drive/root', () => {
    // On Windows this is a bogus drive; on POSIX a bogus absolute path.
    const bogus = isWindows() ? 'Q:\\nope\\deeper' : '/nope-xyz/deeper';
    const r = resolveReal(bogus);
    expect(typeof r).toBe('string');
  });
});
