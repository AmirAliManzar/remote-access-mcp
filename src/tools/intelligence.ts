import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertToolPermitted } from '../core/policy.js';
import { getProjectProfile, listProjectProfiles, setProjectProfile } from '../core/project-profiles.js';

const exec = promisify(execFile);
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.venv', '__pycache__']);
const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|php|rb|cs|cpp|c|h)$/i;

function policy(ctx: ToolContext) { return { allowed_paths: ctx.token.allowed_paths, denied_paths: ctx.token.denied_paths, shell_enabled: ctx.token.shell_enabled }; }
function guard(ctx: ToolContext, tool: string, root?: string) { assertToolPermitted({ tool, scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy(ctx), target: root }); }
async function git(root: string, args: string[]): Promise<string> { const r = await exec('git', args, { cwd: root, maxBuffer: 4 * 1024 * 1024 }); return r.stdout.trim(); }

async function files(root: string, depth = 0): Promise<string[]> {
  if (depth > 8) return [];
  const out: string[] = [];
  let entries: fs.Dirent[]; try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) { if (SKIP.has(e.name)) continue; const p = path.join(root, e.name); if (e.isDirectory()) out.push(...await files(p, depth + 1)); else if (e.isFile() && SOURCE.test(e.name)) out.push(p); }
  return out;
}

function imports(content: string): string[] {
  const out: string[] = [];
  const patterns = [/\b(?:import|export)\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g, /\brequire\(\s*["']([^"']+)["']\s*\)/g];
  for (const re of patterns) for (const m of content.matchAll(re)) out.push(m[1]);
  return [...new Set(out)];
}
function resolveImport(source: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(source), spec);
  const stripped = base.replace(/\.(?:js|jsx|mjs|cjs|ts|tsx)$/, '');
  const candidates = [base, stripped, `${stripped}.ts`, `${stripped}.tsx`, `${stripped}.js`, `${stripped}.jsx`, `${stripped}.mjs`, path.join(stripped, 'index.ts'), path.join(stripped, 'index.js')];
  return candidates.find(p => fs.existsSync(p) && fs.statSync(p).isFile());
}

export async function impactAnalysisForTest(root: string, changed: string[]) {
  const all = await files(root); const reverse = new Map<string, Set<string>>(); let edges = 0;
  for (const source of all) { let c = ''; try { c = await fsp.readFile(source, 'utf8'); } catch { continue; } for (const spec of imports(c)) { const target = resolveImport(source, spec); if (!target) continue; const key = path.resolve(target); if (!reverse.has(key)) reverse.set(key, new Set()); reverse.get(key)!.add(source); edges++; } }
  const queue = changed.map(x => path.resolve(root, x)); const seen = new Set(queue);
  while (queue.length) { const cur = queue.shift()!; for (const parent of reverse.get(cur) || []) if (!seen.has(parent)) { seen.add(parent); queue.push(parent); } }
  return { changed: changed.map(x => path.relative(root, path.resolve(root, x))), impacted: [...seen].map(x => path.relative(root, x)).sort(), edges };
}

function githubToken() { return process.env.GITHUB_TOKEN || process.env.GH_TOKEN; }
async function github(pathname: string): Promise<any> { const token = githubToken(); if (!token) throw new Error('GitHub integration is unavailable: set GITHUB_TOKEN or GH_TOKEN'); const r = await fetch(`https://api.github.com${pathname}`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'remote-access-mcp' } }); if (!r.ok) throw new Error(`GitHub API ${r.status}`); return r.json(); }
function parseRepo(repo: string) { if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('repo must be owner/name'); return repo; }
function sentryToken() { return process.env.SENTRY_AUTH_TOKEN; }
async function sentry(pathname: string): Promise<any> { const token = sentryToken(); if (!token) throw new Error('Sentry integration is unavailable: set SENTRY_AUTH_TOKEN'); const r = await fetch(`https://sentry.io/api/0${pathname}`, { headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'user-agent': 'remote-access-mcp' } }); if (!r.ok) throw new Error(`Sentry API ${r.status}`); return r.json(); }

export function registerIntelligenceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('project_profile', { description: 'Get the persisted developer profile for a project.', inputSchema: { root: z.string() } }, async ({ root }) => { guard(ctx, 'project_profile', root); return { content: [{ type: 'text', text: JSON.stringify(getProjectProfile(ctx.token.token, root) || null) }] }; });
  server.registerTool('project_profile_list', { description: 'List project profiles belonging to the current token.', inputSchema: {} }, async () => { guard(ctx, 'project_profile_list'); return { content: [{ type: 'text', text: JSON.stringify(listProjectProfiles(ctx.token.token)) }] }; });
  server.registerTool('project_profile_set', { description: 'Persist a project profile under RAMCP data, isolated to the current token.', inputSchema: { root: z.string(), name: z.string().min(1).max(120), stack: z.array(z.string().max(80)).max(30).optional(), package_manager: z.string().max(40).optional(), test_command: z.string().max(500).optional(), build_command: z.string().max(500).optional(), lint_command: z.string().max(500).optional(), notes: z.string().max(4000).optional() } }, async (args) => { guard(ctx, 'project_profile_set', args.root); const row = setProjectProfile(ctx.token.token, { root: args.root, name: args.name, stack: args.stack, packageManager: args.package_manager, testCommand: args.test_command, buildCommand: args.build_command, lintCommand: args.lint_command, notes: args.notes }); return { content: [{ type: 'text', text: JSON.stringify(row) }] }; });
  server.registerTool('impact_analysis', { description: 'Build a lightweight reverse dependency graph and identify source files impacted by changes.', inputSchema: { root: z.string(), changed_files: z.array(z.string()).min(1).max(100) } }, async ({ root, changed_files }) => { guard(ctx, 'impact_analysis', root); return { content: [{ type: 'text', text: JSON.stringify(await impactAnalysisForTest(root, changed_files)) }] }; });
  server.registerTool('git_intelligence', { description: 'Read-only Git intelligence: status, recent history, changed files, branches and remotes.', inputSchema: { repo_path: z.string(), mode: z.enum(['overview','history','diff','branches']).default('overview'), limit: z.number().int().min(1).max(50).default(10) } }, async ({ repo_path, mode, limit }) => { guard(ctx, 'git_intelligence', repo_path); const result: any = { branch: await git(repo_path, ['branch', '--show-current']), status: (await git(repo_path, ['status', '--short'])).split('\n').filter(Boolean), remote: (await git(repo_path, ['remote', '-v'])).split('\n').filter(Boolean).slice(0, 20) }; if (mode === 'overview' || mode === 'history') result.history = (await git(repo_path, ['log', `-${limit}`, '--date=iso-strict', '--pretty=format:%h%x09%ad%x09%an%x09%s'])).split('\n').filter(Boolean); if (mode === 'diff') result.diff = await git(repo_path, ['diff', '--stat']); if (mode === 'branches') result.branches = (await git(repo_path, ['branch', '-a', '--no-color'])).split('\n').filter(Boolean).slice(0, limit * 3); return { content: [{ type: 'text', text: JSON.stringify(result) }] }; });
  server.registerTool('github_repo', { description: 'Read a GitHub repository summary using owner/name.', inputSchema: { repo: z.string() } }, async ({ repo }) => { guard(ctx, 'github_repo'); return { content: [{ type: 'text', text: JSON.stringify(await github(`/repos/${parseRepo(repo)}`)) }] }; });
  server.registerTool('github_issues', { description: 'List GitHub issues for a repository. Read-only.', inputSchema: { repo: z.string(), state: z.enum(['open','closed','all']).default('open'), limit: z.number().int().min(1).max(50).default(20) } }, async ({ repo, state, limit }) => { guard(ctx, 'github_issues'); const data = await github(`/repos/${parseRepo(repo)}/issues?state=${state}&per_page=${limit}`); return { content: [{ type: 'text', text: JSON.stringify(data.map((x: any) => ({ number: x.number, title: x.title, state: x.state, user: x.user?.login, updated_at: x.updated_at, html_url: x.html_url }))) }] }; });
  server.registerTool('github_pull_request', { description: 'Read a GitHub pull request and its changed files.', inputSchema: { repo: z.string(), number: z.number().int().positive() } }, async ({ repo, number }) => { guard(ctx, 'github_pull_request'); const r = parseRepo(repo); const [pr, changed] = await Promise.all([github(`/repos/${r}/pulls/${number}`), github(`/repos/${r}/pulls/${number}/files?per_page=100`)]); return { content: [{ type: 'text', text: JSON.stringify({ number: pr.number, title: pr.title, state: pr.state, draft: pr.draft, author: pr.user?.login, base: pr.base?.ref, head: pr.head?.ref, additions: pr.additions, deletions: pr.deletions, changed_files: changed.map((f: any) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })), html_url: pr.html_url }) }] }; });
  server.registerTool('sentry_projects', { description: 'List Sentry projects available to the configured token.', inputSchema: { organization: z.string().min(1).max(100) } }, async ({ organization }) => { guard(ctx, 'sentry_projects'); if (!/^[A-Za-z0-9_.-]+$/.test(organization)) throw new Error('invalid Sentry organization slug'); return { content: [{ type: 'text', text: JSON.stringify(await sentry(`/organizations/${organization}/projects/?per_page=100`)) }] }; });
  server.registerTool('sentry_issues', { description: 'List recent Sentry issues for an organization/project.', inputSchema: { organization: z.string().min(1).max(100), project: z.string().max(100).optional(), query: z.string().max(300).optional(), limit: z.number().int().min(1).max(50).default(20) } }, async ({ organization, project, query, limit }) => { guard(ctx, 'sentry_issues'); if (!/^[A-Za-z0-9_.-]+$/.test(organization) || (project && !/^[A-Za-z0-9_.-]+$/.test(project))) throw new Error('invalid Sentry slug'); const params = new URLSearchParams({ limit: String(limit) }); if (project) params.set('project', project); if (query) params.set('query', query); return { content: [{ type: 'text', text: JSON.stringify(await sentry(`/organizations/${organization}/issues/?${params}`)) }] }; });
  server.registerTool('sentry_issue', { description: 'Inspect one Sentry issue.', inputSchema: { organization: z.string().min(1).max(100), issue_id: z.string().regex(/^\d+$/) } }, async ({ organization, issue_id }) => { guard(ctx, 'sentry_issue'); if (!/^[A-Za-z0-9_.-]+$/.test(organization)) throw new Error('invalid Sentry organization slug'); return { content: [{ type: 'text', text: JSON.stringify(await sentry(`/organizations/${organization}/issues/${issue_id}/`)) }] }; });
  server.registerTool('developer_context_status', { description: 'Report Codebase Memory isolation, Context7 proxy and Context Mode local compatibility.', inputSchema: {} }, async () => { guard(ctx, 'developer_context_status'); return { content: [{ type: 'text', text: JSON.stringify({ codebase_memory: { enabled: process.env.RAMCP_ENABLE_CODEBASE_MEMORY !== '0', isolated: true, root: process.env.RAMCP_CODEBASE_ROOT || null, runtime: process.env.RAMCP_CODEBASE_RUNTIME || '/var/lib/remote-access-mcp/codebase-memory' }, context7: { enabled: true, proxied: true }, context_mode: { installed: true, proxied: false, reason: 'local/client-side context optimization' } }) }] }; });
}
