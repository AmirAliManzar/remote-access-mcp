import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertToolPermitted, assertAllowed, PolicyError } from '../core/policy.js';
import { dataDir } from '../core/platform.js';

export type ChangeSetStatus = 'open' | 'committed' | 'rolling_back' | 'rolled_back';
export interface ChangeSetFile { path: string; backup: string | null; existed: boolean; type: 'file' | 'directory' | 'symlink' | 'other'; }
export interface ChangeSet { id: string; tokenId: string; status: ChangeSetStatus; files: ChangeSetFile[]; created: string; updated: string; }

const storeFile = path.join(dataDir(), 'change-sets.json');
const backupRoot = path.join(dataDir(), 'change-sets');

function load(): ChangeSet[] {
  try { return JSON.parse(fsSync.readFileSync(storeFile, 'utf8')) as ChangeSet[]; } catch { return []; }
}
function save(rows: ChangeSet[]): void {
  fsSync.mkdirSync(path.dirname(storeFile), { recursive: true });
  const tmp = `${storeFile}.tmp-${process.pid}`;
  fsSync.writeFileSync(tmp, JSON.stringify(rows.slice(-200), null, 2), { mode: 0o600 });
  fsSync.renameSync(tmp, storeFile);
}
function tokenFingerprint(ctx: ToolContext): string { return crypto.createHash('sha256').update(ctx.token.token).digest('hex').slice(0, 16); }
function policyFor(ctx: ToolContext) { return { allowed_paths: ctx.token.allowed_paths, denied_paths: ctx.token.denied_paths, shell_enabled: ctx.token.shell_enabled }; }
function findOwned(rows: ChangeSet[], id: string, tokenId: string): ChangeSet | undefined { return rows.find(x => x.id === id && x.tokenId === tokenId); }

/** Capture the pre-mutation state of a path. Safe to call repeatedly for the same path. */
export async function captureChange(ctx: ToolContext, id: string | undefined, target: string): Promise<void> {
  if (!id) return;
  const tid = tokenFingerprint(ctx);
  const rows = load();
  const change = findOwned(rows, id, tid);
  if (!change || change.status !== 'open') throw new PolicyError(`change set ${id} is not open or not owned by this token`);
  assertAllowed(policyFor(ctx), target);
  if (change.files.some(f => f.path === target)) return;

  let existed = false;
  let type: ChangeSetFile['type'] = 'other';
  try {
    const st = await fs.lstat(target);
    existed = true;
    type = st.isDirectory() ? 'directory' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : 'other';
    if (type === 'other') throw new Error(`unsupported path type for change set: ${target}`);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }

  const backup = existed ? path.join(backupRoot, id, crypto.createHash('sha256').update(target).digest('hex')) : null;
  if (backup) {
    await fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
    if (type === 'directory') await fs.cp(target, backup, { recursive: true, dereference: false, force: true });
    else if (type === 'symlink') await fs.symlink(await fs.readlink(target), backup);
    else await fs.copyFile(target, backup);
  }
  change.files.push({ path: target, backup, existed, type });
  change.updated = new Date().toISOString();
  save(rows);
}

async function removeTarget(target: string): Promise<void> {
  try { await fs.rm(target, { recursive: true, force: true }); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
}
async function restoreEntry(entry: ChangeSetFile): Promise<void> {
  if (!entry.existed) { await removeTarget(entry.path); return; }
  if (!entry.backup) throw new Error(`missing backup for ${entry.path}`);
  await fs.mkdir(path.dirname(entry.path), { recursive: true });
  const temp = `${entry.path}.ramcp-restore-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await removeTarget(temp);
  try {
    if (entry.type === 'directory') await fs.cp(entry.backup, temp, { recursive: true, dereference: false, force: true });
    else if (entry.type === 'symlink') await fs.symlink(await fs.readlink(entry.backup), temp);
    else await fs.copyFile(entry.backup, temp);
    await removeTarget(entry.path);
    await fs.rename(temp, entry.path);
  } catch (e) {
    await removeTarget(temp);
    throw e;
  }
}

export async function rollbackChangeSet(ctx: ToolContext, id: string): Promise<{ restored: number; errors: string[] }> {
  const tid = tokenFingerprint(ctx);
  const rows = load();
  const change = findOwned(rows, id, tid);
  if (!change || change.status === 'committed') throw new Error('Change set not found or already committed.');
  change.status = 'rolling_back'; change.updated = new Date().toISOString(); save(rows);
  const errors: string[] = [];
  for (const entry of change.files) {
    try { assertAllowed(policyFor(ctx), entry.path); await restoreEntry(entry); }
    catch (e: any) { errors.push(`${entry.path}: ${e.message || e}`); }
  }
  change.status = errors.length ? 'rolling_back' : 'rolled_back'; change.updated = new Date().toISOString(); save(rows);
  return { restored: change.files.length - errors.length, errors };
}

export function registerChangeTools(server: McpServer, ctx: ToolContext): void {
  const tid = tokenFingerprint(ctx);
  const policy = () => policyFor(ctx);

  server.registerTool('change_set_begin', {
    description: 'Begin a file change set. Mutating filesystem tools can attach to it so rollback also handles created and deleted paths.',
    inputSchema: {},
  }, async () => {
    assertToolPermitted({ tool: 'change_set_begin', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const id = crypto.randomBytes(6).toString('hex');
    const now = new Date().toISOString();
    const change: ChangeSet = { id, tokenId: tid, status: 'open', files: [], created: now, updated: now };
    const rows = load(); rows.push(change); save(rows);
    return { content: [{ type: 'text', text: `Change set ${id} opened.` }] };
  });

  server.registerTool('change_set_add', {
    description: 'Register a path in a change set by capturing its current state. Missing paths are tracked so rollback removes files created later.',
    inputSchema: { id: z.string(), path: z.string() },
  }, async ({ id, path: target }) => {
    assertToolPermitted({ tool: 'change_set_add', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy(), target: target });
    try { await captureChange(ctx, id, target); }
    catch (e: any) { return { content: [{ type: 'text', text: e.message || 'Unable to capture path.' }], isError: true }; }
    return { content: [{ type: 'text', text: `Captured ${target} in ${id}.` }] };
  });

  server.registerTool('change_set_status', {
    description: 'Show a change set and its captured pre-mutation states.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    const change = findOwned(load(), id, tid);
    if (!change) return { content: [{ type: 'text', text: 'Change set not found.' }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(change, null, 2) }] };
  });

  server.registerTool('change_set_commit', {
    description: 'Commit a change set. The recorded backups remain until explicit cleanup.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    assertToolPermitted({ tool: 'change_set_commit', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const rows = load(); const change = findOwned(rows, id, tid);
    if (!change || change.status !== 'open') return { content: [{ type: 'text', text: 'Open change set not found.' }], isError: true };
    change.status = 'committed'; change.updated = new Date().toISOString(); save(rows);
    return { content: [{ type: 'text', text: `Change set ${id} committed.` }] };
  });

  server.registerTool('change_set_rollback', {
    description: 'Idempotently restore every captured path. Created paths are removed; deleted or modified paths are restored. A crash during rollback leaves rolling_back state so the operation can be resumed.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    assertToolPermitted({ tool: 'change_set_rollback', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy() });
    try {
      const result = await rollbackChangeSet(ctx, id);
      if (result.errors.length) return { content: [{ type: 'text', text: `Rollback incomplete for ${id}. Retry to resume.\n${result.errors.join('\n')}` }], isError: true };
      return { content: [{ type: 'text', text: `Rolled back ${result.restored} path(s) in ${id}.` }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: e.message || 'Rollback failed.' }], isError: true };
    }
  });
}
