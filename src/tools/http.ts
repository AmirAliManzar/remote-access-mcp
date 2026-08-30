import net from 'node:net';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const MAX_BODY = 512 * 1024;

export function registerHttpTools(server: McpServer): void {
  // ---- http_request ----------------------------------------------------------
  server.registerTool('http_request',
    {
      description: 'Outbound HTTP request from the server. Method, headers, body, 20s timeout.',
      inputSchema: {
        url: z.string().describe('Full URL including scheme'),
        method: z.string().optional().default('GET').describe('HTTP method'),
        headers: z.record(z.string()).optional().describe('Request headers'),
        body: z.string().optional().describe('Request body (raw text)'),
      },
    },
    async ({ url, method, headers, body }) => {
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
      description: 'Check if a TCP port is reachable on a host. 5s timeout.',
      inputSchema: {
        host: z.string().describe('Hostname or IP'),
        port: z.number().describe('Port number'),
        timeout_ms: z.number().optional().default(5000).describe('Timeout in ms'),
      },
    },
    async ({ host, port, timeout_ms }) => {
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
