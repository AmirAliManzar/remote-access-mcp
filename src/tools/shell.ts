import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PolicyConfig, shellAllowed } from '../core/policy.js';

const exec = promisify(execFile);

const MAX_OUTPUT = 60_000;

export function registerShellTools(server: McpServer, policy: PolicyConfig): void {
  // ---- run_command -------------------------------------------------------
  server.registerTool('run_command',
    {
      description: 'Execute a shell command (via bash -c). Disabled unless shell policy is on. 120s timeout.',
      inputSchema: {
        command: z.string().describe('Command line to run'),
        cwd: z.string().optional().describe('Working directory'),
        timeout_ms: z.number().optional().default(120_000).describe('Timeout in ms (max 600000)'),
      },
    },
    async ({ command, cwd, timeout_ms }) => {
      if (!shellAllowed(policy)) {
        return { content: [{ type: 'text', text: 'Shell execution is disabled. Enable with `ramcp policy shell on`.' }], isError: true };
      }
      const timeout = Math.min(timeout_ms, 600_000);
      try {
        const { stdout, stderr } = await exec('bash', ['-c', command], {
          cwd: cwd || undefined,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
        });
        let out = '';
        if (stdout) out += stdout;
        if (stderr) out += (out ? '\n--- stderr ---\n' : '') + stderr;
        if (!out) out = '(no output)';
        return { content: [{ type: 'text', text: out.slice(0, MAX_OUTPUT) }] };
      } catch (e: any) {
        const msg = [
          e.message || 'command failed',
          e.stdout ? `\n--- stdout ---\n${e.stdout}` : '',
          e.stderr ? `\n--- stderr ---\n${e.stderr}` : '',
        ].filter(Boolean).join('');
        return { content: [{ type: 'text', text: msg.slice(0, MAX_OUTPUT) }], isError: true };
      }
    });

  // ---- process_list ---------------------------------------------------------
  server.registerTool('process_list',
    {
      description: 'List running processes (pid, ppid, user, cpu%, mem%, command). Sorted by CPU.',
      inputSchema: {},
    },
    async () => {
      const { stdout } = await exec('ps', ['axo', 'pid,ppid,user,%cpu,%mem,comm', '--sort=-%cpu']);
      return { content: [{ type: 'text', text: stdout.slice(0, MAX_OUTPUT) }] };
    });

  // ---- kill_process ----------------------------------------------------------
  server.registerTool('kill_process',
    {
      description: 'Send a signal to a process. Default SIGTERM. Disabled unless shell policy is on.',
      inputSchema: {
        pid: z.number().describe('Process ID'),
        signal: z.string().optional().default('SIGTERM').describe('Signal name, e.g. SIGTERM, SIGKILL'),
      },
    },
    async ({ pid, signal }) => {
      if (!shellAllowed(policy)) {
        return { content: [{ type: 'text', text: 'Shell execution is disabled. Enable with `ramcp policy shell on`.' }], isError: true };
      }
      try {
        process.kill(pid, signal as any);
        return { content: [{ type: 'text', text: `Sent ${signal} to ${pid}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    });
}
