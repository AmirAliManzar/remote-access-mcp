import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted, assertAllowed } from '../core/policy.js';
import type { ToolContext } from '../core/context.js';
import { sshRun, assertCapability, buildTailCommand, buildSearchCommand, buildJournalCommand, type FleetHost } from '../core/fleet.js';
import { hostParam } from './shell.js';

const exec = promisify(execFile);
const fleetHostsOf = (ctx: ToolContext): FleetHost[] => ctx.cfg.fleet?.hosts || [];
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
        ...hostParam(ctx),
      },
    },
    async ({ path: file, lines, host }) => {
      if (host) {
        const h = assertCapability(fleetHostsOf(ctx), host, 'logs');
        const { stdout } = await sshRun(h.host, h.port, buildTailCommand(file, lines));
        return { content: [{ type: 'text', text: stdout || '(empty)' }] };
      }
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
        ...hostParam(ctx),
      },
    },
    async ({ path: file, pattern, context, max_results, host }) => {
      if (host) {
        const h = assertCapability(fleetHostsOf(ctx), host, 'logs');
        const { stdout } = await sshRun(h.host, h.port, buildSearchCommand(file, pattern, max_results), { timeoutMs: 180_000 });
        return { content: [{ type: 'text', text: stdout || 'No matches' }] };
      }
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
      description: 'Query system logs for a service. journalctl on Linux, log show on macOS, Get-EventLog on Windows.',
      inputSchema: {
        unit: z.string().regex(/^[A-Za-z0-9@._\-]+$/, 'service/unit names only').describe('Service name, e.g. nginx.service (Linux) or a process name'),
        lines: z.number().optional().default(100).describe('Number of entries'),
        ...hostParam(ctx),
      },
    },
    async ({ unit, lines, host }) => {
      if (host) {
        const h = assertCapability(fleetHostsOf(ctx), host, 'logs');
        const { stdout } = await sshRun(h.host, h.port, buildJournalCommand(unit, lines));
        return { content: [{ type: 'text', text: stdout || '(empty)' }] };
      }
      assertToolPermitted({ tool: 'journal', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const { isWindows, isMac, which, shellCommand, childEnv } = await import('../core/platform.js');
      const n = Math.min(lines, 500);
      try {
        if (isWindows()) {
          const { file, args } = shellCommand(
            `Get-WinEvent -MaxEvents ${n} -FilterHashtable @{LogName='System'} | ` +
            `Where-Object { $_.ProviderName -like '*${unit.replace(/'/g, '')}*' -or $_.Message -like '*${unit.replace(/'/g, '')}*' } | ` +
            `Select-Object TimeCreated,LevelDisplayName,ProviderName,Message | Format-List | Out-String -Width 200`
          );
          const { stdout } = await exec(file, args, { env: childEnv(), windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
          return { content: [{ type: 'text', text: stdout.slice(0, MAX) || '(no entries)' }] };
        }
        if (which('journalctl')) {
          const { stdout } = await exec('journalctl', ['-u', unit, '-n', String(n), '--no-pager', '-o', 'short-iso']);
          return { content: [{ type: 'text', text: stdout.slice(0, MAX) || '(empty)' }] };
        }
        if (isMac()) {
          const { stdout } = await exec('log', ['show', '--last', '1h', '--style', 'compact', '--predicate', `process == "${unit.replace(/"/g, '')}"`], { maxBuffer: 8 * 1024 * 1024 });
          const tail = stdout.split('\n').slice(-n).join('\n');
          return { content: [{ type: 'text', text: tail.slice(0, MAX) || '(no entries)' }] };
        }
        return { content: [{ type: 'text', text: 'No system log backend found (journalctl/log/Get-WinEvent).' }], isError: true };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    });
}
