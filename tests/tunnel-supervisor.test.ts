import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('src/core/tunnel-supervisor.ts'), 'utf8');
const providers = fs.readFileSync(path.resolve('src/core/tunnel-providers.ts'), 'utf8');

describe('Windows localhostrun supervisor', () => {
  it('owns SSH in a reconnect loop', () => {
    expect(source).toContain('while (!stopping)');
    expect(source).toContain('spawn(config.ssh, config.args');
    expect(source).toContain('reconnecting...');
  });

  it('forwards SSH output without closing the parent streams', () => {
    expect(source).toContain("current.stdout?.pipe(process.stdout, { end: false })");
    expect(source).toContain("current.stderr?.pipe(process.stderr, { end: false })");
  });

  it('uses the supervisor only for Windows localhostrun', () => {
    expect(providers).toContain("process.platform === 'win32' && name === 'localhostrun'");
    expect(providers).toContain("'tunnel-supervisor.js'");
    expect(providers).toContain('process.execPath');
    expect(providers).toContain('shell: isWindows');
  });
});
