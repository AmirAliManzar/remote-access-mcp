import net from 'node:net';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted } from '../core/policy.js';
import type { ToolContext } from '../core/context.js';

const MAX_BODY = 512 * 1024;

// Same SSRF guard as web.ts — shared here for http_request.
function isBlockedHost(hostname: string): boolean {
  if (net.isIPv4(hostname)) {
    const parts = hostname.split('.').map(Number);
    const [a, b] = parts;
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    return false;
  }
  if (net.isIPv6(hostname)) {
    const h = hostname.toLowerCase();
    if (h === '::1' || h === '::' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
    const m = h.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isBlockedHost(m[1]);
    return false;
  }
  const blockedNames = ['metadata.google.internal', 'instance-data', 'localhost'];
  return blockedNames.some(n => hostname === n || hostname.endsWith('.' + n));
}

export function registerHttpTools(server: McpServer, ctx: ToolContext): void {
  // ---- http_request ----------------------------------------------------------
  server.registerTool('http_request',
    {
      description: 'Outbound HTTP request. SSRF-guarded: private/metadata ranges refused. 20s timeout.',
      inputSchema: {
        url: z.string().url().describe('Full URL including scheme'),
        method: z.string().optional().default('GET').describe('HTTP method'),
        headers: z.record(z.string()).optional().describe('Request headers'),
        body: z.string().optional().describe('Request body (raw text)'),
      },
    },
    async ({ url, method, headers, body }) => {
      assertToolPermitted({ tool: 'http_request', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { content: [{ type: 'text', text: `Protocol ${parsed.protocol} not allowed.` }], isError: true };
      }
      if (isBlockedHost(parsed.hostname)) {
        return { content: [{ type: 'text', text: `Refusing internal/private host ${parsed.hostname}.` }], isError: true };
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        const resp = await fetch(url, {
          method,
          headers,
          body: body || undefined,
          signal: controller.signal,
          redirect: 'follow',
        });
        clearTimeout(timer);
        const text = (await resp.text()).slice(0, MAX_BODY);
        const out = [
          `status: ${resp.status} ${resp.statusText}`,
          ...[...resp.headers.entries()].map(([k, v]) => `${k}: ${v}`).slice(0, 30),
          '',
          text,
        ].join('\n');
        return { content: [{ type: 'text', text: out }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `request failed: ${e.message}` }], isError: true };
      }
    });

  // ---- port_check --------------------------------------------------------------
  server.registerTool('port_check',
    {
      description: 'Check if a TCP port is reachable on an external host. Refuses internal ranges. 5s timeout.',
      inputSchema: {
        host: z.string().describe('Hostname or IP'),
        port: z.number().int().min(1).max(65535).describe('Port number'),
        timeout_ms: z.number().optional().default(5000).describe('Timeout in ms'),
      },
    },
    async ({ host, port, timeout_ms }) => {
      assertToolPermitted({ tool: 'port_check', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      if (isBlockedHost(host)) {
        return { content: [{ type: 'text', text: `Refusing internal host ${host}.` }], isError: true };
      }
      return await new Promise((resolve) => {
        const socket = new net.Socket();
        const done = (ok: boolean, extra?: string) => {
          socket.destroy();
          resolve({
            content: [{
              type: 'text',
              text: ok
                ? `${host}:${port} — open (${extra || 'connected'})`
                : `${host}:${port} — closed/unreachable${extra ? ` (${extra})` : ''}`,
            }],
            isError: !ok,
          });
        };
        socket.setTimeout(timeout_ms);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false, 'timeout'));
        socket.once('error', (e) => done(false, e.message));
        socket.connect(port, host);
      });
    });
}
