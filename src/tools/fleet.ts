import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { fleetProbe, type FleetHost } from '../core/fleet.js';

/**
 * Fleet meta-tools: listing and probing the machines this gateway can drive.
 * The actual remote operations (run_command, read_file, …) live in their own
 * suites — each gained an optional `host` parameter that routes over SSH
 * when provided. This split keeps one tool per verb (the AI does not have
 * to learn "remote_run_command") while the per-host allowlist gates access.
 */

function hostList(ctx: ToolContext): FleetHost[] {
  return ctx.cfg.fleet?.hosts || [];
}

export function registerFleetTools(server: McpServer, ctx: ToolContext): void {
  // ---- fleet_list ---------------------------------------------------------
  server.registerTool('fleet_list',
    {
      description: 'List fleet machines this gateway can reach over SSH, with their granted tool groups.',
      inputSchema: {},
    },
    async () => {
      const hosts = hostList(ctx);
      if (!hosts.length) return { content: [{ type: 'text', text: '(no fleet hosts — add with `ramcp fleet add`)' }] };
      const out = hosts.map(h =>
        `${h.name.padEnd(14)} ${h.host}${h.port ? ':' + h.port : ''}  tools: ${h.tools.join(',') || '(none)'}${h.note ? '  — ' + h.note : ''}`
      );
      return { content: [{ type: 'text', text: out.join('\n') }] };
    });

  // ---- fleet_status ----------------------------------------------------------
  server.registerTool('fleet_status',
    {
      description: 'Probe every fleet machine over SSH. Reports reachable/unreachable per host.',
      inputSchema: {},
    },
    async () => {
      const hosts = hostList(ctx);
      if (!hosts.length) return { content: [{ type: 'text', text: '(no fleet hosts)' }] };
      const results = await Promise.all(hosts.map(async h => {
        const r = await fleetProbe(h);
        return `${r.ok ? '✔' : '✖'} ${h.name.padEnd(14)} ${h.host}${h.port ? ':' + h.port : ''} ${r.ok ? 'reachable' : 'unreachable — ' + r.detail}`;
      }));
      return { content: [{ type: 'text', text: results.join('\n') }] };
    });
}
