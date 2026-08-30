import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted } from '../core/policy.js';
import type { ToolContext } from '../core/context.js';

const exec = promisify(execFile);
const MAX = 40_000;

// Whitelist of actions — anything else would let the AI restart
// the gateway itself or drop into maintenance targets.
const SERVICE_ACTIONS = ['start', 'stop', 'restart', 'reload', 'status'] as const;
const PROTECTED_UNITS = /^(remote-access-mcp|ssh|sshd|systemd|networkd|resolved|dbus|.*\.target)$/;

export function registerServiceTools(server: McpServer, ctx: ToolContext): void {
  const policy = () => ({
    allowed_paths: ctx.token.allowed_paths,
    denied_paths: ctx.token.denied_paths,
    shell_enabled: ctx.token.shell_enabled,
  });

  // ---- service_status -------------------------------------------------------
  server.registerTool('service_status',
    {
      description: 'Show whether a systemd unit is active/enabled (safe, read-only, any unit).',
      inputSchema: { unit: z.string().regex(/^[A-Za-z0-9@._\\-]+$/) },
    },
    async ({ unit }) => {
      assertToolPermitted({ tool: 'service_status', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      try {
        const active = await exec('systemctl', ['is-active', unit]);
        const enabled = await exec('systemctl', ['is-enabled', unit]);
        return { content: [{ type: 'text', text: `active: ${active.stdout.trim()}\nenabled: ${enabled.stdout.trim()}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.stdout?.trim() || e.message }], isError: true };
      }
    });

  // ---- service_action ----------------------------------------------------------
  server.registerTool('service_action',
    {
      description: 'Start/stop/restart/reload a systemd service. Protected units (ssh, the gateway itself, targets) are refused.',
      inputSchema: {
        unit: z.string().regex(/^[A-Za-z0-9@._\\-]+$/).describe('Service name, e.g. nginx.service'),
        action: z.enum(SERVICE_ACTIONS).describe('start | stop | restart | reload | status'),
      },
    },
    async ({ unit, action }) => {
      assertToolPermitted({ tool: 'service_action', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy() });
      if (action === 'stop' && PROTECTED_UNITS.test(unit)) {
        return { content: [{ type: 'text', text: `Refusing to ${action} protected unit ${unit}.` }], isError: true };
      }
      if (PROTECTED_UNITS.test(unit)) {
        return { content: [{ type: 'text', text: `Refusing to touch protected unit ${unit}.` }], isError: true };
      }
      try {
        const { stdout, stderr } = await exec('systemctl', [action, unit]);
        return { content: [{ type: 'text', text: `${unit} ${action}: ok\n${stdout || stderr || ''}`.slice(0, MAX) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: [e.message, e.stdout, e.stderr].filter(Boolean).join('\n') }], isError: true };
      }
    });
}
