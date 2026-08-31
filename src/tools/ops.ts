import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted } from '../core/policy.js';
import type { ToolContext } from '../core/context.js';

const exec = promisify(execFile);
const MAX = 60_000;

// Nginx config inspection — read-only, explicitly confined to nginx's own
// config tree. We deliberately do NOT let the AI edit nginx configs; that
// stays a shell/git operation so every change flows through the audit trail.
const NGINX_PATHS = ['/etc/nginx/nginx.conf', '/etc/nginx/sites-available', '/etc/nginx/sites-enabled', '/etc/nginx/conf.d', '/etc/nginx/snippets'];

export function registerOpsTools(server: McpServer, ctx: ToolContext): void {
  // ---- environment_inspect ------------------------------------------------------
  server.registerTool('environment_inspect',
    {
      description: 'Show gateway environment variables with secrets masked. Read-only.',
      inputSchema: {},
    },
    async () => {
      assertToolPermitted({ tool: 'environment_inspect', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const lines: string[] = [];
      for (const [k, v] of Object.entries(process.env)) {
        const masked = /pass|secret|token|key|auth|credential/i.test(k)
          ? '[MASKED]'
          : (v || '').length > 120 ? (v || '').slice(0, 120) + '…' : v;
        lines.push(`${k}=${masked}`);
      }
      return { content: [{ type: 'text', text: lines.sort().join('\n') }] };
    });

  // ---- nginx_inspect --------------------------------------------------------------
  server.registerTool('nginx_inspect',
    {
      description: 'Inspect the local nginx configuration: parsed vhosts, enabled sites, upstreams. Read-only.',
      inputSchema: {
        site: z.string().optional().describe('Show one site config only (name from sites-enabled)'),
      },
    },
    async ({ site }) => {
      assertToolPermitted({ tool: 'nginx_inspect', scopes: ctx.token.scopes, readOnly: ctx.readOnly });

      if (site) {
        // Validate site name — no traversal into arbitrary paths
        if (!/^[A-Za-z0-9._\\-]+$/.test(site)) {
          return { content: [{ type: 'text', text: 'Invalid site name.' }], isError: true };
        }
        const f = path.join('/etc/nginx/sites-enabled', site);
        if (!fs.existsSync(f)) {
          return { content: [{ type: 'text', text: `No such site: ${site}` }], isError: true };
        }
        const conf = fs.readFileSync(f, 'utf8');
        return { content: [{ type: 'text', text: conf.slice(0, MAX) }] };
      }

      const out: string[] = [];
      // nginx -T dumps the full merged config — vhosts, upstreams, everything
      try {
        const { stdout } = await exec('nginx', ['-T'], { timeout: 10_000 });
        // Extract server blocks summary
        const serverNames = [...stdout.matchAll(/server_name\s+([^;]+);/g)].map(m => m[1].trim());
        const listen = [...stdout.matchAll(/listen\s+([^;]+);/g)].map(m => m[1].trim());
        const proxies = [...stdout.matchAll(/proxy_pass\s+([^;]+);/g)].map(m => m[1].trim());
        out.push(`server_names (${serverNames.length}):`);
        out.push(...[...new Set(serverNames)].map(s => `  ${s}`));
        out.push(`\nlisten (${listen.length}):`);
        out.push(...[...new Set(listen)].map(s => `  ${s}`));
        out.push(`\nproxy_pass targets (${proxies.length}):`);
        out.push(...[...new Set(proxies)].map(s => `  ${s}`));
      } catch (e: any) {
        // fallback: raw listing
        out.push('(nginx -T failed — listing files instead)');
        for (const p of NGINX_PATHS) {
          if (!fs.existsSync(p)) continue;
          out.push(`${p}:`);
          try {
            for (const f of fs.readdirSync(p)) out.push(`  ${f}`);
          } catch { /* not a dir */ }
        }
      }
      return { content: [{ type: 'text', text: out.join('\n').slice(0, MAX) }] };
    });
}
