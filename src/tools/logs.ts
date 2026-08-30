import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted, assertAllowed } from '../core/policy.js';
import type { ToolContext } from '../core/context.js';

const exec = promisify(execFile);
const MAX = 100_000;

export function registerLogTools(server: McpServer, ctx: ToolContext): void {
  const policy = () => ({
    allowed_paths: ctx.token.allowed_paths,
    denied_paths: ctx.token.denied_paths,
    shell_enabled: ctx.token.shell_enabled,
  });

  // ---- tail_logs -----------------------------------------------------------
  server.registerTool('tail_logs',
    {
      description: 'Last N lines of a text log file. Policy-checked. No follow (MCP is request/response).',
      inputSchema: {
        path: z.string().describe('Log file path'),
        lines: z.number().optional().default(100).describe('Number of lines'),
      },
    },
    async ({ path: file, lines }) => {
      assertToolPermitted({ tool: 'tail_logs', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy(), target: file });
      const stat = fs.statSync(file);
      const fh = fs.openSync(file, 'r');
      try {
        const chunk = Math.min(stat.size, 1024 * 1024); // read at most 1MB from the end
        const buf = Buffer.alloc(chunk);
        fs.readSync(fh, buf, 0, chunk, Math.max(0, stat.size - chunk));
        const tail = buf.toString('utf8').split('\n').slice(-lines).join('\n');
        return { content: [{ type: 'text', text: tail || '(empty)' }] };
      } finally {
        fs.closeSync(fh);
      }
    });

  // ---- search_logs -----------------------------------------------------------
  server.registerTool('search_logs',
    {
      description: 'Regex search in a log file, newest-first, with context lines. Policy-checked.',
      inputSchema: {
        path: z.string().describe('Log file path'),
        pattern: z.string().describe('Regex to search'),
        context: z.number().optional().default(0).describe('Context lines around each match'),
        max_results: z.number().optional().default(50).describe('Max matches'),
      },
    },
    async ({ path: file, pattern, context, max_results }) => {
      assertToolPermitted({ tool: 'search_logs', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy(), target: file });
      const re = new RegExp(pattern);
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      const out: string[] = [];
      for (let i = 0; i < lines.length && out.length < max_results; i++) {
        if (re.test(lines[i])) {
          const from = Math.max(0, i - context);
          const to = Math.min(lines.length, i + context + 1);
          out.push(`L${i + 1}: ` + lines.slice(from, to).join('\n     '));
        }
      }
      return { content: [{ type: 'text', text: out.length ? out.join('\n\n') : 'No matches' }] };
    });

  // ---- journal ----------------------------------------------------------------
  server.registerTool('journal',
    {
      description: 'Query systemd journal for a unit. Returns last N entries. Safe for any unit name (validated).',
      inputSchema: {
        unit: z.string().regex(/^[A-Za-z0-9@._\\-]+$/, 'unit names only').describe('systemd unit name, e.g. nginx.service'),
        lines: z.number().optional().default(100).describe('Number of entries'),
      },
    },
    async ({ unit, lines }) => {
      assertToolPermitted({ tool: 'journal', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      try {
        const { stdout } = await exec('journalctl', ['-u', unit, '-n', String(Math.min(lines, 500)), '--no-pager', '-o', 'short-iso']);
        return { content: [{ type: 'text', text: stdout.slice(0, MAX) || '(empty)' }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    });
}
