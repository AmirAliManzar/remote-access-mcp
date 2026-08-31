import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted } from '../core/policy.js';
import { isWindows, isMac, which, shellCommand, childEnv } from '../core/platform.js';
import type { ToolContext } from '../core/context.js';

const exec = promisify(execFile);
const MAX = 40_000;

// Whitelist of actions — anything else would let the AI restart
// the gateway itself or drop into maintenance targets.
const SERVICE_ACTIONS = ['start', 'stop', 'restart', 'reload', 'status'] as const;
const PROTECTED_UNITS = /^(remote-access-mcp|ssh|sshd|systemd|networkd|resolved|dbus|WinDefend|Winmgmt|RpcSs|.*\.target)$/i;

export function registerServiceTools(server: McpServer, ctx: ToolContext): void {
  const policy = () => ({
    allowed_paths: ctx.token.allowed_paths,
    denied_paths: ctx.token.denied_paths,
    shell_enabled: ctx.token.shell_enabled,
  });

  // ---- service_status -------------------------------------------------------
  server.registerTool('service_status',
    {
      description: 'Show a service state. systemctl on Linux, launchctl on macOS, Get-Service on Windows. Read-only.',
      inputSchema: { unit: z.string().regex(/^[A-Za-z0-9@._\-]+$/) },
    },
    async ({ unit }) => {
      assertToolPermitted({ tool: 'service_status', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      try {
        if (isWindows()) {
          const safe = unit.replace(/'/g, '');
          const { file, args } = shellCommand(`Get-Service -Name '${safe}' | Select-Object Status,Name,DisplayName,StartType | Format-List | Out-String`);
          const { stdout } = await exec(file, args, { env: childEnv(), windowsHide: true });
          return { content: [{ type: 'text', text: stdout.trim() || '(not found)' }] };
        }
        if (which('systemctl')) {
          const active = await exec('systemctl', ['is-active', unit]).catch((e: any) => ({ stdout: e.stdout || 'unknown' }));
          const enabled = await exec('systemctl', ['is-enabled', unit]).catch((e: any) => ({ stdout: e.stdout || 'unknown' }));
          return { content: [{ type: 'text', text: `active: ${String(active.stdout).trim()}\nenabled: ${String(enabled.stdout).trim()}` }] };
        }
        if (isMac()) {
          const { stdout } = await exec('launchctl', ['list']);
          const line = stdout.split('\n').find(l => l.includes(unit));
          return { content: [{ type: 'text', text: line || `(no launchd job matching ${unit})` }] };
        }
        return { content: [{ type: 'text', text: 'No service manager found.' }], isError: true };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.stdout?.trim() || e.message }], isError: true };
      }
    });

  // ---- service_action ----------------------------------------------------------
  server.registerTool('service_action',
    {
      description: 'Start/stop/restart a service. Protected services (ssh, the gateway itself, core OS) are refused.',
      inputSchema: {
        unit: z.string().regex(/^[A-Za-z0-9@._\-]+$/).describe('Service name'),
        action: z.enum(SERVICE_ACTIONS).describe('start | stop | restart | reload | status'),
      },
    },
    async ({ unit, action }) => {
      assertToolPermitted({ tool: 'service_action', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy() });
      if (PROTECTED_UNITS.test(unit)) {
        return { content: [{ type: 'text', text: `Refusing to touch protected service ${unit}.` }], isError: true };
      }
      try {
        if (isWindows()) {
          const verb = action === 'reload' ? 'Restart' : action.charAt(0).toUpperCase() + action.slice(1);
          const safe = unit.replace(/'/g, '');
          const { file, args } = shellCommand(`${verb}-Service -Name '${safe}' -ErrorAction Stop; Get-Service -Name '${safe}' | Select-Object Status,Name | Format-List | Out-String`);
          const { stdout } = await exec(file, args, { env: childEnv(), windowsHide: true });
          return { content: [{ type: 'text', text: `${unit} ${action}: ok\n${stdout}`.slice(0, MAX) }] };
        }
        if (which('systemctl')) {
          const { stdout, stderr } = await exec('systemctl', [action, unit]);
          return { content: [{ type: 'text', text: `${unit} ${action}: ok\n${stdout || stderr || ''}`.slice(0, MAX) }] };
        }
        if (isMac()) {
          const map: Record<string, string[]> = {
            start: ['start', unit], stop: ['stop', unit],
            restart: ['kickstart', '-k', `system/${unit}`], reload: ['kickstart', '-k', `system/${unit}`],
            status: ['list'],
          };
          const { stdout } = await exec('launchctl', map[action]);
          return { content: [{ type: 'text', text: (stdout || `${unit} ${action}: ok`).slice(0, MAX) }] };
        }
        return { content: [{ type: 'text', text: 'No service manager found.' }], isError: true };
      } catch (e: any) {
        return { content: [{ type: 'text', text: [e.message, e.stdout, e.stderr].filter(Boolean).join('\n') }], isError: true };
      }
    });
}
