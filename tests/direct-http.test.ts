import { describe, it, expect } from 'vitest';
import { RESERVED_PUBLIC_PORTS, isReservedPublicPort, chooseDirectPort } from '../src/core/direct-http.js';

describe('direct HTTP port safety', () => {
  it('rejects common public/service ports', () => {
    for (const port of [80, 443, 8443, 2083, 2087, 2096, 8080]) {
      expect(RESERVED_PUBLIC_PORTS.has(port)).toBe(true);
      expect(isReservedPublicPort(port)).toBe(true);
    }
  });

  it('accepts only the dynamic high-port range', () => {
    expect(isReservedPublicPort(49151)).toBe(true);
    expect(isReservedPublicPort(49152)).toBe(false);
    expect(isReservedPublicPort(65535)).toBe(false);
  });

  it('selects a free high port', async () => {
    const port = await chooseDirectPort();
    expect(port).toBeGreaterThanOrEqual(49152);
    expect(port).toBeLessThanOrEqual(65535);
    expect(isReservedPublicPort(port)).toBe(false);
  });
});
