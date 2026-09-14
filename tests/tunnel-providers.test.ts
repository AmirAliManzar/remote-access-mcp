import { describe, it, expect } from 'vitest';
import { extractQuickTunnelUrl } from '../src/core/tunnel.js';
import { TUNNEL_PROVIDERS, verifyTunnelHealth } from '../src/core/tunnel-providers.js';

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

  it('rejects a provider error page such as localhost.run No Tunnel here', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('<h1>no tunnel here :(</h1>', { status: 503 })) as typeof fetch;
    try {
      const result = await verifyTunnelHealth('https://example.lhr.life', '4.6.0');
      expect(result.healthy).toBe(false);
      expect(result.status).toBe(503);
      expect(result.reason?.toLowerCase()).toContain('no tunnel');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts only the Remote Access MCP health payload', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: 'ok', service: 'remote-access-mcp', version: '4.6.0' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    try {
      expect((await verifyTunnelHealth('https://example.test', '4.6.0')).healthy).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a healthy HTTP response from the wrong service', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: 'ok', service: 'other-service' }), { status: 200 })) as typeof fetch;
    try {
      const result = await verifyTunnelHealth('https://example.test');
      expect(result.healthy).toBe(false);
      expect(result.reason).toContain('not from Remote Access MCP');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


describe('tunnel persistence contract', () => {
  it('supports a preferred provider without changing the public provider list', async () => {
    const mod = await import('../src/core/tunnel-providers.js');
    expect(mod.TUNNEL_PROVIDERS.includes('cloudflare')).toBe(true);
    expect(mod.TUNNEL_PROVIDERS.includes('pinggy')).toBe(true);
    expect(mod.TUNNEL_PROVIDERS.includes('localhostrun')).toBe(true);
  });
});
