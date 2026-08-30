import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted } from '../core/policy.js';
import type { ToolContext } from '../core/context.js';

const exec = promisify(execFile);

export function registerSystemTools(server: McpServer, ctx: ToolContext): void {
  // ---- system_info ---------------------------------------------------------
  server.registerTool('system_info',
    {
      description: 'Host, platform, CPU, memory, uptime, and Node.js version of the server.',
      inputSchema: {},
    },
    async () => {
      assertToolPermitted({ tool: 'system_info', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const cpus = os.cpus();
      const out = [
        `hostname: ${os.hostname()}`,
        `platform: ${os.platform()} ${os.release()} (${os.arch()})`,
        `cpu: ${cpus.length}x ${cpus[0]?.model || 'unknown'}`,
        `memory_total: ${Math.round(os.totalmem() / 1024 / 1024)} MB`,
        `memory_free: ${Math.round(os.freemem() / 1024 / 1024)} MB`,
        `uptime_seconds: ${Math.round(os.uptime())}`,
        `loadavg: ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`,
        `node: ${process.version}`,
      ].join('\n');
      return { content: [{ type: 'text', text: out }] };
    });

  // ---- disk_usage ------------------------------------------------------------
  server.registerTool('disk_usage',
    {
      description: 'Filesystem sizes and usage. Human-readable df output.',
      inputSchema: { path: z.string().optional().describe('Restrict to a mount point') },
    },
    async ({ path }) => {
      assertToolPermitted({ tool: 'disk_usage', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const args = ['-h'];
      if (path) args.push(path);
      try {
        const { stdout } = await exec('df', args);
        return { content: [{ type: 'text', text: stdout }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    });

  // ---- network_interfaces -----------------------------------------------------
  server.registerTool('network_interfaces',
    {
      description: 'List network interfaces with addresses. Loopback included.',
      inputSchema: {},
    },
    async () => {
      assertToolPermitted({ tool: 'network_interfaces', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const ifaces = os.networkInterfaces();
      const lines: string[] = [];
      for (const [name, addrs] of Object.entries(ifaces)) {
        for (const a of addrs || []) {
          lines.push(`${name}\t${a.family}\t${a.address}${a.mac ? `\tmac ${a.mac}` : ''}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') || 'none' }] };
    });
}
