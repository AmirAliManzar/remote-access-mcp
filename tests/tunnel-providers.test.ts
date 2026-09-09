import { describe, it, expect } from 'vitest';
import { extractQuickTunnelUrl } from '../src/core/tunnel.js';
import { TUNNEL_PROVIDERS } from '../src/core/tunnel-providers.js';

describe('tunnel provider safety', () => {
  it('never treats the Cloudflare control-plane API URL as public', () => {
    expect(extractQuickTunnelUrl('Requesting new quick Tunnel on trycloudflare.com...\nPost "https://api.trycloudflare.com/tunnel"')).toBeNull();
  });

  it('extracts a real Quick Tunnel hostname', () => {
    expect(extractQuickTunnelUrl('Your quick Tunnel has been created! Visit it at https://random-words.trycloudflare.com')).toBe('https://random-words.trycloudflare.com');
  });

  it('keeps provider order deterministic for auto fallback', () => {
    expect(TUNNEL_PROVIDERS).toEqual(['cloudflare', 'pinggy', 'localhostrun']);
  });
});
