import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted, assertCommandPolicy } from '../core/policy.js';
import { AuditLog } from '../core/audit.js';
import { requestApproval, getApproval, decideApproval, consumeApproval } from '../core/approvals.js';
import { shellCommand, childEnv, isWindows } from '../core/platform.js';
import type { ToolContext } from '../core/context.js';

const exec = promisify(execFile);
const MAX_OUTPUT = 60_000;

// Shell injection surface: we run a shell by design (the tool IS a shell).
// Guard rails: timeout, output cap, no TTY, cwd policy-checked.
export function registerShellTools(server: McpServer, ctx: ToolContext): void {
  const policy = () => ({
    allowed_paths: ctx.token.allowed_paths,
    denied_paths: ctx.token.denied_paths,
    shell_enabled: ctx.token.shell_enabled,
  });

  // ---- run_command -------------------------------------------------------
  server.registerTool('run_command',
    {
      description: 'Execute a shell command (bash/sh on POSIX, PowerShell/cmd on Windows). Requires shell enabled. 120s default timeout.',
      inputSchema: {
        command: z.string().describe('Command line to run'),
        cwd: z.string().optional().describe('Working directory (policy-checked when local)'),
        timeout_ms: z.number().optional().default(120_000).describe('Timeout in ms (max 600000)'),
        approval_id: z.string().optional().describe('Approval id previously approved by an authorized operator'),
      },
    },
    async ({ command, cwd, timeout_ms, approval_id }) => {
      if (!ctx.token.shell_enabled) {
        return { content: [{ type: 'text', text: 'Shell execution is disabled for this token. Enable with `ramcp policy shell on`.' }], isError: true };
      }
      assertToolPermitted({ tool: 'run_command', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy(), target: cwd });
      const tokenId = AuditLog.fingerprint(ctx.token.token);
      const approval = approval_id ? getApproval(approval_id, tokenId) : undefined;
      if (ctx.token.approval_mode === 'approval-required') {
        if (!approval || approval.status !== 'approved' || approval.command !== command || approval.cwd !== cwd) {
          const pending = requestApproval(tokenId, command, cwd);
          return { content: [{ type: 'text', text: `Approval required. Ask an authorized operator to approve approval_id=${pending.id}, then retry with approval_id.` }], isError: true };
        }
        if (!consumeApproval(approval.id, tokenId, command, cwd)) {
          return { content: [{ type: 'text', text: 'Approval is invalid, already consumed, or does not match this exact command/cwd.' }], isError: true };
        }
      }
      assertCommandPolicy({ command_allowlist: ctx.token.command_allowlist, approval_mode: 'auto' }, command, true);
      const timeout = Math.min(timeout_ms, 600_000);
      const { file, args } = shellCommand(command);
      try {
        const { stdout, stderr } = await exec(file, args, {
          cwd: cwd || undefined,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          env: childEnv(),
          windowsHide: true,
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

  server.registerTool('approval_decide', {
    description: 'Approve or reject a pending shell command approval request.',
    inputSchema: { id: z.string(), approved: z.boolean() },
  }, async ({ id, approved }) => {
    assertToolPermitted({ tool: 'approval_decide', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const actorId = AuditLog.fingerprint(ctx.token.token);
    const privileged = ctx.token.role === 'admin' || ctx.token.role === 'deployer';
    const requesterId = privileged ? undefined : actorId;
    const a = getApproval(id, requesterId);
    if (!a) return { content: [{ type: 'text', text: 'Approval not found or not authorized.' }], isError: true };
    decideApproval(id, requesterId, approved, actorId);
    return { content: [{ type: 'text', text: `Approval ${id}: ${approved ? 'approved' : 'rejected'}.` }] };
  });

  // ---- process_list ---------------------------------------------------------
  server.registerTool('process_list',
    {
      description: 'List running processes with CPU/memory. Uses ps on POSIX, Get-Process on Windows.',
      inputSchema: {},
    },
    async () => {
      assertToolPermitted({ tool: 'process_list', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      try {
        if (isWindows()) {
          const { file, args } = shellCommand(
            'Get-Process | Sort-Object -Property CPU -Descending | Select-Object -First 40 Id,ProcessName,CPU,WS | Format-Table -AutoSize | Out-String -Width 200'
          );
          const { stdout } = await exec(file, args, { maxBuffer: 8 * 1024 * 1024, env: childEnv(), windowsHide: true });
          return { content: [{ type: 'text', text: stdout.slice(0, MAX_OUTPUT) }] };
        }
        const { stdout } = await exec('ps', ['axo', 'pid,ppid,user,%cpu,%mem,comm', '--sort=-%cpu']);
        return { content: [{ type: 'text', text: stdout.slice(0, MAX_OUTPUT) }] };
      } catch (e: any) {
        // BSD/macOS ps rejects --sort
        try {
          const { stdout } = await exec('ps', ['axo', 'pid,ppid,user,pcpu,pmem,comm']);
          return { content: [{ type: 'text', text: stdout.slice(0, MAX_OUTPUT) }] };
        } catch {
          return { content: [{ type: 'text', text: e.message }], isError: true };
        }
      }
    });

  // ---- kill_process ----------------------------------------------------------
  server.registerTool('kill_process',
    {
      description: 'Send a signal to a process (SIGTERM/SIGKILL; on Windows the process is terminated). Cannot kill the gateway itself.',
      inputSchema: {
        pid: z.number().describe('Process ID'),
        signal: z.string().optional().default('SIGTERM').describe('Signal name, e.g. SIGTERM, SIGKILL'),
      },
    },
    async ({ pid, signal }) => {
      if (!ctx.token.shell_enabled) {
        return { content: [{ type: 'text', text: 'Shell execution is disabled for this token.' }], isError: true };
      }
      assertToolPermitted({ tool: 'kill_process', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      // Guardrail: the AI must not be able to kill the gateway or init.
      if (pid === process.pid || pid === process.ppid || (!isWindows() && pid === 1)) {
        return { content: [{ type: 'text', text: `Refusing to signal pid ${pid} (protected).` }], isError: true };
      }
      try {
        process.kill(pid, signal as any);
        return { content: [{ type: 'text', text: `Sent ${signal} to ${pid}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    });
}
