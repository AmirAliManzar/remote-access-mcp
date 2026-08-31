import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_JS = path.resolve(__dirname, '..', 'dist', 'server', 'run.js');

/**
 * The dist/ output must boot under plain Node ESM — no bundler, no tsx,
 * no require() leakage. This test exists because exactly that class of
 * bug shipped once: tests passed under vitest (CJS interop) while the
 * production service crash-looped under pure ESM.
 */
describe('production boot (pure ESM)', () => {
  it('dist/server/run.js boots and stays alive', async () => {
    expect(fs.existsSync(RUN_JS)).toBe(true);
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-boot-'));

    const child = spawn('node', [RUN_JS], {
      env: {
        ...process.env,
        HOME: tmpHome,
        RAMCP_TOKEN: 'boot-check-token',
        RAMCP_PORT: String(18765 + Math.floor(Math.random() * 1000)), // never collide with real gateways
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    // Give it 2s to boot, then check it is STILL running (not crashed)
    await new Promise((r) => setTimeout(r, 2000));
    const stillAlive = child.exitCode === null && !child.killed;
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));

    expect(stillAlive).toBe(true);
    expect(stderr).not.toContain('ReferenceError');
  }, 10_000);
});
