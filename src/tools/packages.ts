import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted } from '../core/policy.js';
import type { ToolContext } from '../core/context.js';

const exec = promisify(execFile);
const MAX = 60_000;

export function registerPackageTools(server: McpServer, ctx: ToolContext): void {
  // ---- package_list ------------------------------------------------------------
  server.registerTool('package_list',
    {
      description: 'List installed packages. Debian/Ubuntu (dpkg) with fallback to (npm -g).',
      inputSchema: {
        filter: z.string().optional().describe('Filter by name substring'),
        limit: z.number().optional().default(200).describe('Max results'),
      },
    },
    async ({ filter, limit }) => {
      assertToolPermitted({ tool: 'package_list', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      try {
        const { stdout } = await exec('dpkg-query', ['-W', '-f', '${Package}\\t${Version}\\n']);
        let lines = stdout.split('\n').filter(Boolean);
        if (filter) lines = lines.filter(l => l.toLowerCase().includes(filter.toLowerCase()));
        return { content: [{ type: 'text', text: lines.slice(0, limit).join('\n') }] };
      } catch {
        const { stdout } = await exec('npm', ['ls', '-g', '--depth=0', '--parseable']);
        return { content: [{ type: 'text', text: stdout.slice(0, MAX) }] };
      }
    });

  // ---- package_install ----------------------------------------------------------
  server.registerTool('package_install',
    {
      description: 'Install a system package (apt, requires root) or a global npm package (npm -g). Auto-detects.',
      inputSchema: {
        name: z.string().regex(/^[a-zA-Z0-9@/._+\\-]+$/).describe('Package name'),
        kind: z.enum(['auto', 'apt', 'npm']).optional().default('auto').describe('Which package manager'),
      },
    },
    async ({ name, kind }) => {
      assertToolPermitted({ tool: 'package_install', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const useNpm = kind === 'npm' || (kind === 'auto' && name.startsWith('@'));
      try {
        if (useNpm) {
          const { stdout, stderr } = await exec('npm', ['install', '-g', name], { timeout: 300_000 });
          return { content: [{ type: 'text', text: (stdout || stderr || 'installed').slice(0, MAX) }] };
        }
        const { stdout, stderr } = await exec('apt-get', ['install', '-y', name], { timeout: 300_000 });
        return { content: [{ type: 'text', text: (stdout || stderr || 'installed').slice(0, MAX) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: [e.message, e.stdout, e.stderr].filter(Boolean).join('\n').slice(0, MAX) }], isError: true };
      }
    });

  // ---- package_remove --------------------------------------------------------------
  server.registerTool('package_remove',
    {
      description: 'Remove a system package. Refuses packages the gateway itself depends on.',
      inputSchema: { name: z.string().regex(/^[a-zA-Z0-9@/._+\\-]+$/) },
    },
    async ({ name }) => {
      assertToolPermitted({ tool: 'package_remove', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const protectedPkgs = /^(nodejs|npm|nginx|openssh-server|systemd)$/;
      if (protectedPkgs.test(name)) {
        return { content: [{ type: 'text', text: `Refusing to remove protected package ${name}.` }], isError: true };
      }
      const useNpm = name.startsWith('@') || !name.includes('.');
      try {
        if (useNpm) {
          const { stdout, stderr } = await exec('npm', ['uninstall', '-g', name], { timeout: 120_000 });
          return { content: [{ type: 'text', text: (stdout || stderr || 'removed').slice(0, MAX) }] };
        }
        const { stdout, stderr } = await exec('apt-get', ['remove', '-y', name], { timeout: 300_000 });
        return { content: [{ type: 'text', text: (stdout || stderr || 'removed').slice(0, MAX) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: [e.message, e.stdout, e.stderr].filter(Boolean).join('\n').slice(0, MAX) }], isError: true };
      }
    });
}
