import { describe, it, expect } from 'vitest';
import { isPathAllowed, resolveReal, PolicyConfig } from '../src/core/policy.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function mkPolicy(allowed: string[], denied: string[] = []): PolicyConfig {
  return { allowed_paths: allowed, denied_paths: denied, shell_enabled: false };
}

describe('policy engine', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-test-'));
  const sub = path.join(tmp, 'sub');
  fs.mkdirSync(sub, { recursive: true });

  it('allows paths under an allowed root', () => {
    const p = mkPolicy([tmp]);
    expect(isPathAllowed(p, tmp)).toBe(true);
    expect(isPathAllowed(p, path.join(tmp, 'sub', 'file.txt'))).toBe(true);
  });

  it('denies paths outside the allowed root', () => {
    const p = mkPolicy([tmp]);
    expect(isPathAllowed(p, '/etc/passwd')).toBe(false);
    expect(isPathAllowed(p, path.join(tmp, '..', 'other'))).toBe(false);
  });

  it('deny wins over allow', () => {
    const p = mkPolicy([tmp], [sub]);
    expect(isPathAllowed(p, path.join(sub, 'secret.txt'))).toBe(false);
    expect(isPathAllowed(p, path.join(tmp, 'ok.txt'))).toBe(true);
  });

  it('empty allow list denies everything', () => {
    const p = mkPolicy([]);
    expect(isPathAllowed(p, tmp)).toBe(false);
  });

  it('resolves .. traversal before checking', () => {
    const p = mkPolicy([tmp]);
    const sneaky = path.join(tmp, 'sub', '..', '..', 'etc');
    expect(isPathAllowed(p, sneaky)).toBe(false);
  });

  it('resolveReal collapses symlinks', () => {
    const link = path.join(tmp, 'link');
    if (fs.existsSync(link)) fs.unlinkSync(link);
    fs.symlinkSync(sub, link);
    const p = mkPolicy([sub]);
    expect(isPathAllowed(p, path.join(link, 'x'))).toBe(true);   // via symlink into allowed
    const p2 = mkPolicy([tmp], [sub]);
    expect(isPathAllowed(p2, path.join(link, 'x'))).toBe(false); // deny catches symlink
    fs.unlinkSync(link);
  });

  it('resolveReal handles non-existent targets', () => {
    const target = path.join(tmp, 'does', 'not', 'exist', 'yet.txt');
    expect(resolveReal(target).startsWith(resolveReal(tmp))).toBe(true);
  });
});
