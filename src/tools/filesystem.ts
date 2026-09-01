import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted, assertAllowed, PolicyError } from '../core/policy.js';
import { sshRun, assertCapability, FleetHost, buildReadCommand, buildWriteCommand, buildDeleteCommand, buildListCommand, buildFileInfoCommand, buildSearchCommand } from '../core/fleet.js';
import { hostParam } from './shell.js';
import type { ToolContext } from '../core/context.js';

const B64_DECODE = (s: string) => Buffer.from(s.replace(/\n/g, ''), 'base64').toString('utf8');

function fleetHostsOf(ctx: ToolContext): FleetHost[] { return ctx.cfg.fleet?.hosts || []; }

export function registerFilesystemTools(server: McpServer, ctx: ToolContext): void {
  const perm = (tool: string, target?: string) =>
    assertToolPermitted({ tool, scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy(), target });

  const policy = () => ({
    allowed_paths: ctx.token.allowed_paths,
    denied_paths: ctx.token.denied_paths,
    shell_enabled: ctx.token.shell_enabled,
  });

  // ---- list_directory ---------------------------------------------------
  server.registerTool('list_directory',
    {
      description: 'List a directory. Policy-checked locally; on fleet hosts needs the fs group.',
      inputSchema: { path: z.string().describe('Directory path'), ...hostParam(ctx) },
    },
    async ({ path: dir, host }) => {
      if (host && !fleetHostsOf(ctx).length) {
        return { content: [{ type: 'text', text: 'No fleet hosts are configured on this gateway. Add one with `ramcp fleet add` before using host parameters.' }], isError: true };
      }
      if (host) {
        const h = assertCapability(fleetHostsOf(ctx), host, 'fs');
        const { stdout } = await sshRun(h.host, h.port, buildListCommand(dir));
        return { content: [{ type: 'text', text: stdout || '(empty)' }] };
      }
      perm('list_directory', dir);
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const lines = entries.map(e => {
        const suffix = e.isDirectory() ? '/' : e.isSymbolicLink() ? '@' : '';
        return `${e.name}${suffix}`;
      });
      return { content: [{ type: 'text', text: lines.length ? lines.join('\n') : '(empty)' }] };
    });

  // ---- read_file ---------------------------------------------------------
  server.registerTool('read_file',
    {
      description: 'Read a UTF-8 text file. Policy-checked.',
      inputSchema: {
        path: z.string().describe('File path'),
        offset: z.number().optional().describe('Start line (1-based)'),
        limit: z.number().optional().describe('Max lines to return'),
        ...hostParam(ctx),
      },
    },
    async ({ path: file, offset, limit, host }) => {
      if (host && !fleetHostsOf(ctx).length) {
        return { content: [{ type: 'text', text: 'No fleet hosts are configured on this gateway. Add one with `ramcp fleet add` before using host parameters.' }], isError: true };
      }
      if (host) {
        const h = assertCapability(fleetHostsOf(ctx), host, 'fs');
        const { stdout } = await sshRun(h.host, h.port, buildReadCommand(file));
        if (!stdout.trim()) return { content: [{ type: 'text', text: `No such file or unreadable: ${file}` }], isError: true };
        let data = B64_DECODE(stdout.trim());
        if (offset || limit) {
          const lines = data.split('\n');
          const start = Math.max((offset || 1) - 1, 0);
          data = lines.slice(start, start + (limit || lines.length)).join('\n');
        }
        return { content: [{ type: 'text', text: data }] };
      }
      perm('read_file', file);
      let data = await fsp.readFile(file, 'utf8');
      if (offset || limit) {
        const lines = data.split('\n');
        const start = Math.max((offset || 1) - 1, 0);
        data = lines.slice(start, start + (limit || lines.length)).join('\n');
      }
      return { content: [{ type: 'text', text: data }] };
    });

  // ---- write_file --------------------------------------------------------
  server.registerTool('write_file',
    {
      description: 'Create or overwrite a file with UTF-8 text content. Policy-checked.',
      inputSchema: {
        path: z.string().describe('File path'),
        content: z.string().describe('Full file content'),
        mkdir: z.boolean().optional().default(true).describe('Create parent directories'),
        ...hostParam(ctx),
      },
    },
    async ({ path: file, content, mkdir, host }) => {
      if (host && !fleetHostsOf(ctx).length) {
        return { content: [{ type: 'text', text: 'No fleet hosts are configured on this gateway. Add one with `ramcp fleet add` before using host parameters.' }], isError: true };
      }
      if (host) {
        const h = assertCapability(fleetHostsOf(ctx), host, 'fs');
        const b64 = Buffer.from(content, 'utf8').toString('base64');
        await sshRun(h.host, h.port, buildWriteCommand(file, content, mkdir), { stdin: b64 });
        return { content: [{ type: 'text', text: `Wrote ${Buffer.byteLength(content)} bytes to ${file} on ${host}` }] };
      }
      perm('write_file', file);
      if (mkdir) await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, content, 'utf8');
      return { content: [{ type: 'text', text: `Wrote ${Buffer.byteLength(content)} bytes to ${file}` }] };
    });

  // ---- edit_file ---------------------------------------------------------
  server.registerTool('edit_file',
    {
      description: 'Replace exact text inside a file. Policy-checked.',
      inputSchema: {
        path: z.string().describe('File path'),
        old_text: z.string().describe('Exact text to find'),
        new_text: z.string().describe('Replacement text'),
        all: z.boolean().optional().default(false).describe('Replace every occurrence'),
      },
    },
    async ({ path: file, old_text, new_text, all }) => {
      perm('edit_file', file);
      const data = await fsp.readFile(file, 'utf8');
      if (!data.includes(old_text)) {
        return { content: [{ type: 'text', text: `old_text not found in ${file}` }], isError: true };
      }
      const updated = all ? data.split(old_text).join(new_text) : data.replace(old_text, new_text);
      await fsp.writeFile(file, updated, 'utf8');
      return { content: [{ type: 'text', text: `Edited ${file}` }] };
    });

  // ---- delete_path -------------------------------------------------------
  server.registerTool('delete_path',
    {
      description: 'Delete a file or a directory tree. Policy-checked locally. Destructive.',
      inputSchema: { path: z.string().describe('Path to delete'), ...hostParam(ctx) },
    },
    async ({ path: target, host }) => {
      if (host && !fleetHostsOf(ctx).length) {
        return { content: [{ type: 'text', text: 'No fleet hosts are configured on this gateway. Add one with `ramcp fleet add` before using host parameters.' }], isError: true };
      }
      if (host) {
        const h = assertCapability(fleetHostsOf(ctx), host, 'fs');
        await sshRun(h.host, h.port, buildDeleteCommand(target));
        return { content: [{ type: 'text', text: `Deleted ${target} on ${host}` }] };
      }
      perm('delete_path', target);
      const st = fs.lstatSync(target);
      if (st.isDirectory()) {
        await fsp.rm(target, { recursive: true });
      } else {
        await fsp.unlink(target);
      }
      return { content: [{ type: 'text', text: `Deleted ${target}` }] };
    });

  // ---- search_code --------------------------------------------------------
  server.registerTool('search_code',
    {
      description: 'Recursive regex search under a directory. Policy-checked. Returns file:line:match.',
      inputSchema: {
        path: z.string().describe('Directory to search'),
        pattern: z.string().describe('JavaScript regex, e.g. "TODO|FIXME"'),
        include: z.string().optional().describe('Substring filter for file names, e.g. ".ts"'),
        max_results: z.number().optional().default(100).describe('Cap on matches'),
        ...hostParam(ctx),
      },
    },
    async ({ path: dir, pattern, include, max_results, host }) => {
      if (host && !fleetHostsOf(ctx).length) {
        return { content: [{ type: 'text', text: 'No fleet hosts are configured on this gateway. Add one with `ramcp fleet add` before using host parameters.' }], isError: true };
      }
      if (host) {
        const h = assertCapability(fleetHostsOf(ctx), host, 'fs');
        const cmd = buildSearchCommand(dir, pattern, max_results) + (include ? ` | grep ${include}` : '');
        const { stdout } = await sshRun(h.host, h.port, cmd, { timeoutMs: 180_000 });
        return { content: [{ type: 'text', text: stdout || 'No matches' }] };
      }
      perm('search_code', dir);
      const re = new RegExp(pattern);
      const results: string[] = [];
      const walk = async (d: string): Promise<void> => {
        if (results.length >= max_results) return;
        let entries: fs.Dirent[];
        try { entries = await fsp.readdir(d, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
          if (results.length >= max_results) return;
          if (e.name === '.git' || e.name === 'node_modules') continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) { await walk(full); continue; }
          if (!e.isFile()) continue;
          if (include && !e.name.includes(include)) continue;
          let content: string;
          try { content = await fsp.readFile(full, 'utf8'); }
          catch { continue; }
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && results.length < max_results; i++) {
            if (re.test(lines[i])) results.push(`${full}:${i + 1}:${lines[i].trim().slice(0, 200)}`);
          }
        }
      };
      await walk(dir);
      return { content: [{ type: 'text', text: results.length ? results.join('\n') : 'No matches' }] };
    });

  // ---- file_info -----------------------------------------------------------
  server.registerTool('file_info',
    {
      description: 'Stat a file or directory: size, timestamps, permissions, owner. Policy-checked locally.',
      inputSchema: { path: z.string().describe('Path'), ...hostParam(ctx) },
    },
    async ({ path: target, host }) => {
      if (host && !fleetHostsOf(ctx).length) {
        return { content: [{ type: 'text', text: 'No fleet hosts are configured on this gateway. Add one with `ramcp fleet add` before using host parameters.' }], isError: true };
      }
      if (host) {
        const h = assertCapability(fleetHostsOf(ctx), host, 'fs');
        const { stdout } = await sshRun(h.host, h.port, buildFileInfoCommand(target));
        return { content: [{ type: 'text', text: stdout }] };
      }
      perm('file_info', target);
      const st = await fsp.stat(target);
      const out = [
        `path: ${target}`,
        `type: ${st.isDirectory() ? 'directory' : 'file'}`,
        `size: ${st.size}`,
        `mode: ${(st.mode & 0o777).toString(8)}`,
        `mtime: ${st.mtime.toISOString()}`,
        `atime: ${st.atime.toISOString()}`,
      ].join('\n');
      return { content: [{ type: 'text', text: out }] };
    });
}

export { PolicyError };
