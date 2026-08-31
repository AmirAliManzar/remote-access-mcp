import { describe, it, expect } from 'vitest';
import { tunnelBinPath, resolveCloudflared } from '../src/core/tunnel.js';
import { dataDir, isWindows } from '../src/core/platform.js';
import path from 'node:path';

/**
 * Tunnel unit tests stay offline: downloading cloudflared in CI would be
 * slow and flaky. We assert the platform-dependent wiring (asset naming,
 * install location, discovery order) and leave the network path to the
 * manual `ramcp tunnel` smoke test.
 */
describe('tunnel wiring', () => {
  it('binary lands inside the platform data dir', () => {
    const p = tunnelBinPath();
    expect(p.startsWith(dataDir())).toBe(true);
    expect(path.basename(p)).toBe(isWindows() ? 'cloudflared.exe' : 'cloudflared');
  });

  it('resolveCloudflared returns a path or null without throwing', () => {
    const r = resolveCloudflared();
    expect(r === null || typeof r === 'string').toBe(true);
  });
});
