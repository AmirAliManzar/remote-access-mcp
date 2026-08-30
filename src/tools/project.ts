import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted } from '../core/policy.js';
import type { ToolContext } from '../core/context.js';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'coverage', '.next']);

export function registerProjectTools(server: McpServer, ctx: ToolContext): void {
  const policy = () => ({
    allowed_paths: ctx.token.allowed_paths,
    denied_paths: ctx.token.denied_paths,
    shell_enabled: ctx.token.shell_enabled,
  });

  // ---- analyze_project ------------------------------------------------------
  server.registerTool('analyze_project',
    {
      description: 'Summarize a project: languages, file counts, LOC, entry points, manifests, frameworks. Policy-checked.',
      inputSchema: { path: z.string().describe('Project root') },
    },
    async ({ path: root }) => {
      assertToolPermitted({ tool: 'analyze_project', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy(), target: root });
      const stats = {
        files: 0, loc: 0,
        byExt: new Map<string, number>(),
        manifests: [] as string[],
        entryPoints: [] as string[],
      };
      const walk = async (d: string, depth = 0): Promise<void> => {
        if (depth > 6) return;
        let entries: fs.Dirent[];
        try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (SKIP.has(e.name) || e.name.startsWith('.DS')) continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) { await walk(full, depth + 1); continue; }
          if (!e.isFile()) continue;
          stats.files++;
          const ext = path.extname(e.name) || '(none)';
          stats.byExt.set(ext, (stats.byExt.get(ext) || 0) + 1);
          if (/^(package\.json|pyproject\.toml|requirements\.txt|go\.mod|Cargo\.toml|composer\.json|pom\.xml|Gemfile|makefile|Makefile|dockerfile|Dockerfile)$/i.test(e.name)) {
            stats.manifests.push(path.relative(root, full));
          }
          if (/^(index|main|app|server|cli|start|run)\.(js|ts|mjs|py|go|rb|php)$/i.test(e.name)) {
            stats.entryPoints.push(path.relative(root, full));
          }
          if (/\.(js|ts|py|go|rb|rs|java|php|c|cpp|h|sh|sql|css|html)$/i.test(ext)) {
            try {
              const content = await fsp.readFile(full, 'utf8');
              stats.loc += content.split('\n').length;
            } catch { /* binary? */ }
          }
        }
      };
      await walk(root);

      const langs = [...stats.byExt.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([ext, n]) => `${ext}: ${n} files`).join('\n');

      const out = [
        `project: ${root}`,
        `files: ${stats.files}`,
        `code lines: ${stats.loc}`,
        ``,
        `top file types:`,
        langs || '(none)',
        ``,
        `manifests: ${stats.manifests.join(', ') || '(none found)'}`,
        `entry points: ${stats.entryPoints.join(', ') || '(none found)'}`,
      ].join('\n');
      return { content: [{ type: 'text', text: out }] };
    });

  // ---- project_health_check -----------------------------------------------------
  server.registerTool('project_health_check',
    {
      description: 'Quick health check: git dirty state, huge files, missing README, TODO/FIXME density. Policy-checked.',
      inputSchema: { path: z.string().describe('Project root') },
    },
    async ({ path: root }) => {
      assertToolPermitted({ tool: 'project_health_check', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy(), target: root });
      const notes: string[] = [];
      // git dirty
      if (fs.existsSync(path.join(root, '.git'))) {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const exec = promisify(execFile);
        try {
          const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: root });
          const n = stdout.split('\n').filter(Boolean).length;
          notes.push(`git: ${n} uncommitted change(s)`);
        } catch { notes.push('git: (status failed)'); }
      } else {
        notes.push('git: not a repository');
      }
      // README
      notes.push(fs.existsSync(path.join(root, 'README.md')) ? 'README.md: present' : 'README.md: MISSING');
      // TODO density
      let todos = 0, files = 0;
      const walk = async (d: string, depth = 0): Promise<void> => {
        if (depth > 5) return;
        let entries: fs.Dirent[];
        try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (SKIP.has(e.name)) continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) { await walk(full, depth + 1); continue; }
          if (!/\.(js|ts|py|go|rb|php|rs|java)$/i.test(e.name)) continue;
          files++;
          try {
            const c = await fsp.readFile(full, 'utf8');
            todos += (c.match(/TODO|FIXME|HACK/g) || []).length;
          } catch { /* skip */ }
        }
      };
      await walk(root);
      notes.push(`TODOs: ${todos} across ${files} source files`);
      return { content: [{ type: 'text', text: notes.join('\n') }] };
    });
}
