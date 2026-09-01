import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted } from '../core/policy.js';
import { shellCommand, childEnv, isWindows } from '../core/platform.js';
import type { ToolContext } from '../core/context.js';
import { sshRun, buildRunCommand, type FleetHost } from '../core/fleet.js';

const exec = promisify(execFile);
const MAX_OUTPUT = 60_000;

function fleetHosts(ctx: ToolContext): FleetHost[] {
  return ctx.cfg.fleet?.hosts || [];
}

/**
 * Shared optional host parameter — ALWAYS present in the schema.
 *
 * If it were only advertised when a fleet exists, the SDK would silently
 * strip a client's host=<x> argument on a fleet-less gateway and the tool
 * would run the "remote" command LOCALLY on the gateway itself — a silent
 * security downgrade. Keeping the parameter in every schema means the
 * handler always sees it and can refuse with a clear error instead.
 */
export function hostParam(ctx: ToolContext, names?: string): { host: any } {
  const hosts = fleetHosts(ctx);
  const hint = hosts.length
    ? `Run on fleet machine${names ? ` (${names})` : ''}: ${hosts.map(h => h.name).join(', ')}. Omit for local.`
    : 'Reserved for fleet hosts — none configured yet (see `ramcp fleet add`). Ignored locally.';
  return {
    host: z.string().optional().describe(hint),
  };
}

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
      description: 'Execute a shell command (bash/sh on POSIX, PowerShell/cmd on Windows; sh on fleet hosts). Requires shell enabled. 120s default timeout.',
      inputSchema: {
        command: z.string().describe('Command line to run'),
        cwd: z.string().optional().describe('Working directory (policy-checked when local)'),
        timeout_ms: z.number().optional().default(120_000).describe('Timeout in ms (max 600000)'),
        ...hostParam(ctx),
      },
    },
    async ({ command, cwd, host, timeout_ms }) => {
      if (!ctx.token.shell_enabled) {
        return { content: [{ type: 'text', text: 'Shell execution is disabled for this token. Enable with `ramcp policy shell on`.' }], isError: true };
      }

      // Fleet path: per-host allowlist + SSH, no local policy check (the
      // command does not touch this machine).
      // If the client names a host but the schema had no fleet to advertise
      // (empty config), the SDK still may pass the arg through — a silent
      // LOCAL fallback would run a "remote" command on the gateway itself.
      if (host && !fleetHosts(ctx).length) {
        return { content: [{ type: 'text', text: 'No fleet hosts are configured on this gateway. Add one with `ramcp fleet add` before using host parameters.' }], isError: true };
      }
      if (host) {
        const h = (await import('../core/fleet.js')).assertCapability(fleetHosts(ctx), host, 'shell');
        const { stdout } = await sshRun(h.host, h.port, buildRunCommand(command, undefined, timeout_ms), { timeoutMs: Math.min(timeout_ms, 600_000) });
        return { content: [{ type: 'text', text: (stdout || '(no output)').slice(0, MAX_OUTPUT) }] };
      }

      assertToolPermitted({ tool: 'run_command', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy(), target: cwd });
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

  // ---- process_list ---------------------------------------------------------
  server.registerTool('process_list',
    {
      description: 'List running processes with CPU/memory. Local machine, or a fleet host with the shell group.',
      inputSchema: {
        ...hostParam(ctx),
      },
    },
    async ({ host }) => {
      if (host) {
        const h = (await import('../core/fleet.js')).assertCapability(fleetHosts(ctx), host, 'shell');
        const { stdout } = await sshRun(h.host, h.port, "ps axo pid,ppid,user,pcpu,pmem,comm --sort=-pcpu | head -80", { timeoutMs: 30_000 });
        return { content: [{ type: 'text', text: stdout.slice(0, MAX_OUTPUT) }] };
      }
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
