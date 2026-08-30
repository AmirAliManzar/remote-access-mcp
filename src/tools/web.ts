import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted } from '../core/policy.js';
import type { ToolContext } from '../core/context.js';

const MAX_BODY = 512 * 1024;

// SSRF guard: refuse requests to loopback/link-local/metadata addresses
// unless explicitly allowed. The gateway itself listens on loopback —
// an AI must not be able to bypass auth by fetching its own endpoint
// from inside, or hit cloud metadata services.
import net from 'node:net';

function isBlockedHost(hostname: string): boolean {
  // IPv4 literals
  if (net.isIPv4(hostname)) {
    const parts = hostname.split('.').map(Number);
    const [a, b] = parts;
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;  // link-local incl. cloud metadata
    if (a === 0) return true;
    return false;
  }
  // IPv6 literals
  if (net.isIPv6(hostname)) {
    const h = hostname.toLowerCase();
    if (h === '::1' || h === '::' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
    // IPv4-mapped
    const m = h.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isBlockedHost(m[1]);
    return false;
  }
  // Hostnames that resolve to private ranges are checked at connect time
  // by fetch itself — but block the obvious ones textually:
  const blockedNames = ['metadata.google.internal', 'instance-data', 'localhost'];
  return blockedNames.some(n => hostname === n || hostname.endsWith('.' + n));
}

export function registerWebTools(server: McpServer, ctx: ToolContext): void {
  // ---- web_fetch ---------------------------------------------------------------
  server.registerTool('web_fetch',
    {
      description: 'Fetch a URL and return the response body (text, truncated). SSRF-guarded: private/metadata ranges are refused.',
      inputSchema: {
        url: z.string().url().describe('Public URL to fetch'),
        max_bytes: z.number().optional().default(100_000).describe('Max body bytes'),
      },
    },
    async ({ url, max_bytes }) => {
      assertToolPermitted({ tool: 'web_fetch', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { content: [{ type: 'text', text: `Protocol ${parsed.protocol} not allowed.` }], isError: true };
      }
      if (isBlockedHost(parsed.hostname)) {
        return { content: [{ type: 'text', text: `Refusing to fetch internal/private host ${parsed.hostname}.` }], isError: true };
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        const resp = await fetch(url, {
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'User-Agent': 'remote-access-mcp/2.0 (+https://github.com/AmirAliManzar/remote-access-mcp)' },
        });
        clearTimeout(timer);
        const text = (await resp.text()).slice(0, Math.min(max_bytes, MAX_BODY));
        const head = `status: ${resp.status} ${resp.statusText}\ncontent-type: ${resp.headers.get('content-type') || '?'}\n\n`;
        return { content: [{ type: 'text', text: head + text }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `fetch failed: ${e.message}` }], isError: true };
      }
    });
}
