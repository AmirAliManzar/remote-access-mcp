import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertToolPermitted, assertAllowed } from '../core/policy.js';
import { dataDir, isLinux, which } from '../core/platform.js';

interface Manifest {
  name: string;
  version: string;
  description?: string;
  entry: string;
  permissions?: string[];
  scopes?: string[];
}

interface PluginLockRecord {
  name: string;
  version: string;
  sha256: string;
  installedAt: string;
}

const MAX_FILES = 256;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_TOOL_COUNT = 64;
const MAX_TOOL_SCHEMA_BYTES = 64 * 1024;
const PLUGIN_TIMEOUT_MS = 15_000;
const ALLOWED_PERMISSIONS = new Set(['fs.read', 'fs.write', 'process']);
const LOCK_FILE = () => path.join(root(), 'plugins.lock.json');
const LOCK_GUARD = () => path.join(root(), '.plugins.lock.guard');
const root = () => path.join(dataDir(), 'plugins');

function withPluginLock<T>(fn: () => T): T {
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
  const guard = LOCK_GUARD();
  let fd: number | undefined;
  const deadline = Date.now() + 10_000;
  while (fd === undefined) {
    try {
      fd = fs.openSync(guard, 'wx', 0o600);
    } catch (error: any) {
      if (error?.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('Plugin registry is busy.');
      try {
        const stat = fs.statSync(guard);
        if (Date.now() - stat.mtimeMs > 30_000) fs.unlinkSync(guard);
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(guard); }
}

function pluginDir(name: string): string {
  return path.join(root(), name.replace(/[^a-zA-Z0-9._-]/g, '_'));
}

function safeEntry(m: Manifest): string | null {
  if (!m.entry || path.isAbsolute(m.entry)) return null;
  const dir = pluginDir(m.name);
  const resolved = path.resolve(dir, m.entry);
  const rel = path.relative(dir, resolved);
  if (!rel || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return resolved;
}

function validateManifest(raw: unknown): Manifest {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid plugin manifest.');
  const m = raw as Partial<Manifest>;
  if (typeof m.name !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(m.name)) throw new Error('Invalid plugin name.');
  if (typeof m.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(m.version)) throw new Error('Invalid plugin version.');
  if (typeof m.entry !== 'string' || !m.entry || path.isAbsolute(m.entry)) throw new Error('Invalid plugin entry.');
  if (m.permissions !== undefined && (!Array.isArray(m.permissions) || m.permissions.some(p => typeof p !== 'string' || !ALLOWED_PERMISSIONS.has(p)))) {
    throw new Error('Invalid plugin permissions.');
  }
  if (m.scopes !== undefined && (!Array.isArray(m.scopes) || m.scopes.some(s => typeof s !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(s)))) {
    throw new Error('Invalid plugin scopes.');
  }
  return { name: m.name, version: m.version, description: typeof m.description === 'string' ? m.description.slice(0, 1000) : undefined, entry: m.entry, permissions: m.permissions || [], scopes: m.scopes || [] };
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'plugins.lock.json') continue;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Plugins may not contain symbolic links.');
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(full);
      else throw new Error('Unsupported plugin filesystem entry.');
      if (out.length > MAX_FILES) throw new Error(`Plugin exceeds ${MAX_FILES} files.`);
    }
  };
  visit(dir);
  return out;
}

function fingerprint(dir: string): string {
  const hash = crypto.createHash('sha256');
  let total = 0;
  const files = walkFiles(dir).sort();
  for (const file of files) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    const stat = fs.statSync(file);
    total += stat.size;
    if (total > MAX_TOTAL_BYTES) throw new Error(`Plugin exceeds ${MAX_TOTAL_BYTES} byte limit.`);
    hash.update(rel).update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function loadLock(): Record<string, PluginLockRecord> {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE(), 'utf8')) as Record<string, PluginLockRecord>; } catch { return {}; }
}

function saveLock(lock: Record<string, PluginLockRecord>): void {
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
  const tmp = `${LOCK_FILE()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, LOCK_FILE());
}

function manifests(): Array<Manifest & { sha256?: string; verified: boolean }> {
  if (!fs.existsSync(root())) return [];
  const lock = loadLock();
  return fs.readdirSync(root(), { withFileTypes: true }).flatMap(d => {
    if (!d.isDirectory()) return [];
    try {
      const dir = path.join(root(), d.name);
      const m = validateManifest(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
      const sha256 = fingerprint(dir);
      const record = lock[m.name];
      return [{ ...m, sha256, verified: !!record && record.version === m.version && record.sha256 === sha256 }];
    } catch {
      return [];
    }
  });
}

function assertPluginAccess(ctx: ToolContext, m: Manifest): void {
  if (ctx.token.scopes.length && !ctx.token.scopes.includes('plugins')) {
    throw new Error('Plugin access requires the plugins scope.');
  }
  if (m.scopes?.some(s => ctx.token.scopes.length && !ctx.token.scopes.includes(s))) {
    throw new Error(`Plugin ${m.name} requires unavailable token scopes.`);
  }
}

function nodePermissionArgs(m: Manifest, dir: string): string[] {
  const args = ['--permission', `--allow-fs-read=${dir}`];
  const data = path.join(dir, 'data');
  if (m.permissions?.includes('fs.write')) {
    fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    args.push(`--allow-fs-write=${data}`);
  }
  if (m.permissions?.includes('process')) args.push('--allow-child-process');
  return args;
}

function sandboxCommand(m: Manifest, dir: string, nodeModules: string): { command: string; args: string[] } | null {
  const host = hostEntry();
  const blocker = path.resolve(path.dirname(host), 'plugin-network-blocker.cjs');
  const nodeArgs = [...nodePermissionArgs(m, dir), `--allow-fs-read=${nodeModules}`, `--allow-fs-read=${host}`, `--allow-fs-read=${blocker}`, '--require', blocker, host, '--plugin-dir', dir, '--entry', safeEntry(m)!];
  const unshare = which('unshare');
  const nft = which('nft');
  if (isLinux() && unshare && nft) {
    const script = `\"${nft}\" add table inet ramcp_plugin_filter && \"${nft}\" add chain inet ramcp_plugin_filter output '{ type filter hook output priority 0; policy drop; }' && node=\"$1\"; shift; exec \"$node\" \"$@\"`;
    return { command: unshare, args: ['--fork', '--net', '--', '/bin/sh', '-c', script, '--', process.execPath, ...nodeArgs] };
  }
  if (process.env.RAMCP_PLUGIN_UNSANDBOXED === '1') return { command: process.execPath, args: nodeArgs };
  return null;
}

function hostEntry(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'plugin-host.js');
}

async function withPluginClient<T>(m: Manifest, fn: (client: Client) => Promise<T>): Promise<T> {
  const dir = pluginDir(m.name);
  const entry = safeEntry(m);
  if (!entry) throw new Error('Plugin entry escapes its installation directory.');
  const lock = loadLock()[m.name];
  if (!lock || lock.version !== m.version || lock.sha256 !== fingerprint(dir)) throw new Error(`Plugin ${m.name} failed integrity verification.`);

  const nodeModules = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules');
  const sandbox = sandboxCommand(m, dir, nodeModules);
  if (!sandbox) throw new Error('Plugin execution requires the built-in sandbox; set RAMCP_PLUGIN_UNSANDBOXED=1 only for explicit local trust.');
  const transport = new StdioClientTransport({
    command: sandbox.command,
    args: sandbox.args,
    cwd: dir,
    env: { PATH: process.env.PATH || '', LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1' },
    stderr: 'pipe',
    maxBufferSize: 2 * 1024 * 1024,
  });
  const client = new Client({ name: 'remote-access-mcp-plugin-bridge', version: '1' });
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Plugin startup timed out after ${PLUGIN_TIMEOUT_MS}ms.`)), PLUGIN_TIMEOUT_MS)),
    ]);
    return await Promise.race([
      fn(client),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Plugin execution timed out after ${PLUGIN_TIMEOUT_MS}ms.`)), PLUGIN_TIMEOUT_MS)),
    ]);
  } finally {
    await client.close().catch(() => {});
  }
}

function jsonSchemaToZod(schema: any): any {
  if (!schema || typeof schema !== 'object') return z.any();
  if (schema.enum && Array.isArray(schema.enum) && schema.enum.length) {
    if (schema.enum.every((v: unknown) => typeof v === 'string')) return z.enum(schema.enum as [string, ...string[]]);
    return z.union(schema.enum.map((v: unknown) => z.literal(v as string | number | boolean | null)) as [any, any, ...any[]]);
  }
  if (schema.anyOf && Array.isArray(schema.anyOf) && schema.anyOf.length >= 2) return z.union(schema.anyOf.slice(0, 8).map(jsonSchemaToZod) as [any, any, ...any[]]);
  switch (schema.type) {
    case 'string': return z.string();
    case 'number': return z.number();
    case 'integer': return z.number().int();
    case 'boolean': return z.boolean();
    case 'null': return z.null();
    case 'array': return z.array(jsonSchemaToZod(schema.items));
    case 'object': {
      const shape: Record<string, any> = {};
      for (const [key, value] of Object.entries(schema.properties || {}).slice(0, 128)) {
        const field = jsonSchemaToZod(value);
        shape[key] = (schema.required || []).includes(key) ? field : field.optional();
      }
      return z.object(shape).passthrough();
    }
    default: return z.any();
  }
}

export async function registerInstalledPlugins(server: McpServer, ctx: ToolContext): Promise<void> {
  for (const m of manifests()) {
    if (!m.verified) continue;
    try {
      assertPluginAccess(ctx, m);
      const listed = await withPluginClient(m, client => client.listTools());
      if (listed.tools.length > MAX_TOOL_COUNT) continue;
      for (const tool of listed.tools) {
        if (!/^[a-zA-Z0-9._-]{1,64}$/.test(tool.name)) continue;
        const schemaText = JSON.stringify(tool.inputSchema || {});
        if (schemaText.length > MAX_TOOL_SCHEMA_BYTES) continue;
        const exposedName = `plugin_${m.name}__${tool.name}`;
        try {
          server.registerTool(exposedName, {
            description: `[plugin:${m.name}] ${String(tool.description || '').slice(0, 2000)}`,
            inputSchema: jsonSchemaToZod(tool.inputSchema || { type: 'object', properties: {} }),
          }, async (args: Record<string, unknown>) => {
            assertToolPermitted({ tool: exposedName, scopes: ctx.token.scopes, readOnly: ctx.readOnly });
            const result = await withPluginClient(m, client => client.callTool({ name: tool.name, arguments: args }));
            return result as any;
          });
        } catch {
          // A single malformed/conflicting tool must not block other plugins.
        }
      }
    } catch {
      // Broken, untrusted, incompatible or unsandboxable plugins are fail-closed.
    }
  }
}

export function registerPluginTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('plugin_list', {
    description: 'List installed Remote Access MCP plugins and integrity verification status.',
    inputSchema: {},
  }, async () => {
    assertToolPermitted({ tool: 'plugin_list', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    return { content: [{ type: 'text', text: JSON.stringify(manifests(), null, 2) }] };
  });

  server.registerTool('plugin_install', {
    description: 'Install a local plugin after validating its manifest, filesystem tree and integrity fingerprint.',
    inputSchema: { source: z.string() },
  }, async ({ source }) => {
    assertToolPermitted({ tool: 'plugin_install', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const src = path.resolve(source);
    assertAllowed({ allowed_paths: ctx.token.allowed_paths, denied_paths: ctx.token.denied_paths, shell_enabled: ctx.token.shell_enabled }, src);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return { content: [{ type: 'text', text: 'Plugin source directory not found.' }], isError: true };
    try {
      const m = validateManifest(JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8')));
      const entry = path.resolve(src, m.entry);
      const rel = path.relative(src, entry);
      if (!rel || rel.startsWith('..' + path.sep) || path.isAbsolute(rel) || !fs.existsSync(entry)) throw new Error('Plugin entry is invalid or outside the source directory.');
      fingerprint(src);
      return withPluginLock(() => {
        const dest = pluginDir(m.name);
        if (fs.existsSync(dest)) throw new Error(`Plugin ${m.name} is already installed; remove it first.`);
        fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
        const copyRecursive = (from: string, to: string) => {
          for (const e of fs.readdirSync(from, { withFileTypes: true })) {
            const a = path.join(from, e.name), b = path.join(to, e.name);
            if (e.isSymbolicLink()) throw new Error('Plugins may not contain symbolic links.');
            if (e.isDirectory()) { fs.mkdirSync(b, { mode: 0o700 }); copyRecursive(a, b); }
            else if (e.isFile()) fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL);
          }
        };
        fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
        try {
          copyRecursive(src, dest);
          const installed = validateManifest(JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8')));
          if (installed.name !== m.name || installed.version !== m.version || installed.entry !== m.entry) throw new Error('Plugin source changed during installation.');
          const sha256 = fingerprint(dest);
          const lock = loadLock();
          lock[m.name] = { name: m.name, version: m.version, sha256, installedAt: new Date().toISOString() };
          saveLock(lock);
          return { content: [{ type: 'text', text: `Plugin ${m.name}@${m.version} installed and fingerprinted (${sha256.slice(0, 16)}…).` }] };
        } catch (error) {
          fs.rmSync(dest, { recursive: true, force: true });
          throw error;
        }
      });
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  server.registerTool('plugin_remove', {
    description: 'Remove an installed local plugin and its integrity record.',
    inputSchema: { name: z.string().regex(/^[a-zA-Z0-9._-]+$/) },
  }, async ({ name }) => {
    assertToolPermitted({ tool: 'plugin_remove', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    return withPluginLock(() => {
      const p = pluginDir(name);
      if (!fs.existsSync(p)) return { content: [{ type: 'text', text: 'Plugin not found.' }], isError: true };
      fs.rmSync(p, { recursive: true, force: true });
      const lock = loadLock();
      delete lock[name];
      saveLock(lock);
      return { content: [{ type: 'text', text: `Plugin ${name} removed.` }] };
    });
  });
}
