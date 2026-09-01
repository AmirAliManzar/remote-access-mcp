import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted } from '../core/policy.js';
import { isWindows, isMac, which, shellCommand, childEnv } from '../core/platform.js';
import type { ToolContext } from '../core/context.js';
import { sshRun, assertCapability, buildPackageListCommand, type FleetHost } from '../core/fleet.js';
import { hostParam } from './shell.js';

const exec = promisify(execFile);
const fleetHostsOf = (ctx: ToolContext): FleetHost[] => ctx.cfg.fleet?.hosts || [];
const MAX = 60_000;

/** Which package manager this machine actually has. */
function detectManager(): 'apt' | 'brew' | 'winget' | 'choco' | 'npm' {
  if (isWindows()) {
    if (which('winget')) return 'winget';
    if (which('choco')) return 'choco';
    return 'npm';
  }
  if (isMac()) return which('brew') ? 'brew' : 'npm';
  return which('apt-get') ? 'apt' : 'npm';
}

export function registerPackageTools(server: McpServer, ctx: ToolContext): void {
  // ---- package_list ------------------------------------------------------------
  server.registerTool('package_list',
    {
      description: 'List installed packages. Auto-detects apt / brew / winget / choco, falls back to global npm.',
      inputSchema: {
        filter: z.string().optional().describe('Filter by name substring'),
        limit: z.number().optional().default(200).describe('Max results'),
        ...hostParam(ctx),
      },
    },
    async ({ filter, limit, host }) => {
      if (host && !fleetHostsOf(ctx).length) {
        return { content: [{ type: 'text', text: 'No fleet hosts are configured on this gateway. Add one with `ramcp fleet add` before using host parameters.' }], isError: true };
      }
      if (host) {
        const h = assertCapability(fleetHostsOf(ctx), host, 'packages');
        const { stdout } = await sshRun(h.host, h.port, buildPackageListCommand(filter));
        const lines = stdout.split('\n').filter(Boolean).slice(0, limit);
        return { content: [{ type: 'text', text: `[${host}/apt]\n` + lines.join('\n') }] };
      }
      assertToolPermitted({ tool: 'package_list', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const mgr = detectManager();
      try {
        let stdout = '';
        if (mgr === 'apt') {
          ({ stdout } = await exec('dpkg-query', ['-W', '-f', '${Package}\\t${Version}\\n']));
        } else if (mgr === 'brew') {
          ({ stdout } = await exec('brew', ['list', '--versions']));
        } else if (mgr === 'winget') {
          const { file, args } = shellCommand('winget list');
          ({ stdout } = await exec(file, args, { env: childEnv(), windowsHide: true, maxBuffer: 8 * 1024 * 1024 }));
        } else if (mgr === 'choco') {
          ({ stdout } = await exec('choco', ['list', '--local-only']));
        } else {
          ({ stdout } = await exec('npm', ['ls', '-g', '--depth=0']));
        }
        let lines = stdout.split(/\r?\n/).filter(Boolean);
        if (filter) lines = lines.filter(l => l.toLowerCase().includes(filter.toLowerCase()));
        return { content: [{ type: 'text', text: `[${mgr}]\n` + lines.slice(0, limit).join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `${mgr} failed: ${e.message}` }], isError: true };
      }
    });

  // ---- package_install ----------------------------------------------------------
  server.registerTool('package_install',
    {
      description: 'Install a package using the platform manager (apt/brew/winget/choco) or npm -g for scoped names.',
      inputSchema: {
        name: z.string().regex(/^[a-zA-Z0-9@/._+\-]+$/).describe('Package name'),
        kind: z.enum(['auto', 'system', 'npm']).optional().default('auto').describe('Which manager family'),
      },
    },
    async ({ name, kind }) => {
      assertToolPermitted({ tool: 'package_install', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const useNpm = kind === 'npm' || (kind === 'auto' && name.startsWith('@'));
      const mgr = useNpm ? 'npm' : detectManager();
      try {
        let stdout = '', stderr = '';
        if (mgr === 'npm') {
          ({ stdout, stderr } = await exec('npm', ['install', '-g', name], { timeout: 300_000 }));
        } else if (mgr === 'apt') {
          ({ stdout, stderr } = await exec('apt-get', ['install', '-y', name], { timeout: 300_000 }));
        } else if (mgr === 'brew') {
          ({ stdout, stderr } = await exec('brew', ['install', name], { timeout: 600_000 }));
        } else if (mgr === 'winget') {
          ({ stdout, stderr } = await exec('winget', ['install', '--silent', '--accept-package-agreements', '--accept-source-agreements', '-e', '--id', name], { timeout: 600_000, windowsHide: true }));
        } else {
          ({ stdout, stderr } = await exec('choco', ['install', '-y', name], { timeout: 600_000, windowsHide: true }));
        }
        return { content: [{ type: 'text', text: `[${mgr}] ` + (stdout || stderr || 'installed').slice(0, MAX) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: [e.message, e.stdout, e.stderr].filter(Boolean).join('\n').slice(0, MAX) }], isError: true };
      }
    });

  // ---- package_remove --------------------------------------------------------------
  server.registerTool('package_remove',
    {
      description: 'Remove a package. Refuses packages the gateway itself depends on.',
      inputSchema: {
        name: z.string().regex(/^[a-zA-Z0-9@/._+\-]+$/),
        kind: z.enum(['auto', 'system', 'npm']).optional().default('auto'),
      },
    },
    async ({ name, kind }) => {
      assertToolPermitted({ tool: 'package_remove', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      if (/^(nodejs|node|npm|nginx|openssh-server|systemd|remote-access-mcp)$/i.test(name)) {
        return { content: [{ type: 'text', text: `Refusing to remove protected package ${name}.` }], isError: true };
      }
      const useNpm = kind === 'npm' || (kind === 'auto' && name.startsWith('@'));
      const mgr = useNpm ? 'npm' : detectManager();
      try {
        let stdout = '', stderr = '';
        if (mgr === 'npm') {
          ({ stdout, stderr } = await exec('npm', ['uninstall', '-g', name], { timeout: 120_000 }));
        } else if (mgr === 'apt') {
          ({ stdout, stderr } = await exec('apt-get', ['remove', '-y', name], { timeout: 300_000 }));
        } else if (mgr === 'brew') {
          ({ stdout, stderr } = await exec('brew', ['uninstall', name], { timeout: 300_000 }));
        } else if (mgr === 'winget') {
          ({ stdout, stderr } = await exec('winget', ['uninstall', '--silent', '-e', '--id', name], { timeout: 300_000, windowsHide: true }));
        } else {
          ({ stdout, stderr } = await exec('choco', ['uninstall', '-y', name], { timeout: 300_000, windowsHide: true }));
        }
        return { content: [{ type: 'text', text: `[${mgr}] ` + (stdout || stderr || 'removed').slice(0, MAX) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: [e.message, e.stdout, e.stderr].filter(Boolean).join('\n').slice(0, MAX) }], isError: true };
      }
    });
}
