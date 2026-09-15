import { describe, expect, it } from 'vitest';
import { getTunnelRecoveryOrder } from '../src/server/run.js';

describe('tunnel recovery order', () => {
  it('moves past a failed preferred provider before retrying it', () => {
    expect(getTunnelRecoveryOrder('localhostrun', 'localhostrun')).toEqual([
      'cloudflare',
      'pinggy',
      'nport',
      'localhostrun',
    ]);
  });

  it('rotates correctly when Pinggy fails', () => {
    expect(getTunnelRecoveryOrder('pinggy', 'localhostrun')).toEqual([
      'localhostrun',
      'cloudflare',
      'nport',
      'pinggy',
    ]);
  });

  it('uses the preferred provider only for initial selection', () => {
    expect(getTunnelRecoveryOrder(undefined, 'localhostrun')).toEqual([
      'localhostrun',
      'cloudflare',
      'pinggy',
      'nport',
    ]);
  });
});
