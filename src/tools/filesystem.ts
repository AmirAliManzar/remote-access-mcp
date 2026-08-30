import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PolicyConfig, assertAllowed, PolicyError } from '../core/policy.js';

export function registerFilesystemTools(server: McpServer, policy: PolicyConfig): void {
  // ---- list_directory ---------------------------------------------------
  server.registerTool('list_directory',
    {
      description: 'List a directory. Policy-checked.',
      inputSchema: { path: z.string().describe('Directory path') },
    },
    async ({ path: dir }) => {
      assertAllowed(policy, dir);
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
      inputSchema: { path: z.string().describe('File path') },
    },
    async ({ path: file }) => {
      assertAllowed(policy, file);
      const data = await fsp.readFile(file, 'utf8');
      return { content: [{ type: 'text', text: data }] };
    });

  // ---- write_file --------------------------------------------------------
  server.registerTool('write_file',
    {
      description: 'Create or overwrite a file with UTF-8 text content. Policy-checked.',
      inputSchema: {
        path: z.string().describe('File path'),
        content: z.string().describe('Full file content'),
      },
    },
    async ({ path: file, content }) => {
      assertAllowed(policy, file);
      await fsp.mkdir(path.dirname(file), { recursive: true });
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
      assertAllowed(policy, file);
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
      description: 'Delete a file or a directory tree. Policy-checked. Destructive.',
      inputSchema: { path: z.string().describe('Path to delete') },
    },
    async ({ path: target }) => {
      assertAllowed(policy, target);
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
        include: z.string().optional().describe('Glob filter for file names, e.g. "*.ts"'),
        max_results: z.number().optional().default(100).describe('Cap on matches'),
      },
    },
    async ({ path: dir, pattern, include, max_results }) => {
      assertAllowed(policy, dir);
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
          if (include) {
            try { if (!new RegExp(include.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')).test(e.name)) continue; }
            catch { /* bad glob → no filter */ }
          }
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
      description: 'Stat a file or directory: size, timestamps, permissions, owner. Policy-checked.',
      inputSchema: { path: z.string().describe('Path') },
    },
    async ({ path: target }) => {
      assertAllowed(policy, target);
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

// Re-export so tool modules share the same error surface.
export { PolicyError };
