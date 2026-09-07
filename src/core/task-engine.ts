import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './platform.js';
import { AuditLog } from './audit.js';
import { getAgentProfile, type AgentProfileId } from './agent-profiles.js';
import { scopeOf } from './policy.js';
import type { AgentResult, AutonomyLevel, TaskContext, TaskState } from './agent-contracts.js';

export interface TaskAction {
  id: string;
  agent?: AgentProfileId;
  tool: string;
  arguments?: Record<string, unknown>;
  dependsOn?: string[];
  condition?: 'always' | 'on_success' | 'on_failure';
  timeoutMs?: number;
  retries?: number;
  rollback?: { tool: string; arguments?: Record<string, unknown> };
  verify?: { tool: string; arguments?: Record<string, unknown> };
}

export interface TaskDefinition {
  goal: string;
  actions: TaskAction[];
  autonomy: AutonomyLevel;
  dryRun?: boolean;
}

export interface TaskActionRecord extends TaskAction {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'rolled_back';
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
}

export interface TaskRecord {
  id: string;
  tokenId: string;
  goal: string;
  autonomy: AutonomyLevel;
  state: TaskState;
  dryRun: boolean;
  createdAt: string;
  updatedAt: string;
  actions: TaskActionRecord[];
  error?: string;
  approvalId?: string;
  context: TaskContext;
}

type Invoke = (name: string, args: Record<string, unknown>) => Promise<any>;

const MAX_TASKS = 500;
const MAX_ACTIONS = 64;
function storePath(dir: string): string { return path.join(dir, 'tasks.json'); }
function lockPath(dir: string): string { return path.join(dir, 'tasks.lock'); }

function load(dir: string): TaskRecord[] {
  try {
    const value = JSON.parse(fs.readFileSync(storePath(dir), 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function save(rows: TaskRecord[], dir = dataDir()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = storePath(dir);
  const lock = lockPath(dir);
  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      try {
        const current = new Map(load(dir).map(t => [t.id, t]));
        for (const row of rows) current.set(row.id, row);
        const retained = [...current.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_TASKS);
        const tmp = `${store}.${process.pid}-${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(retained, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, store);
      } finally { fs.rmSync(lock, { recursive: true, force: true }); }
      return;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
      if (Date.now() - start > 10_000) throw new Error('timed out waiting for task persistence lock');
      const until = Date.now() + 10; while (Date.now() < until) {}
    }
  }
}

function clone<T>(v: T): T { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
function now(): string { return new Date().toISOString(); }
function tokenId(token: string): string { return AuditLog.fingerprint(token); }

function validate(def: TaskDefinition): void {
  if (!def.goal.trim()) throw new Error('task goal must not be empty');
  if (!Array.isArray(def.actions) || def.actions.length < 1 || def.actions.length > MAX_ACTIONS) throw new Error(`task actions must contain 1-${MAX_ACTIONS} actions`);
  const ids = new Set<string>();
  for (const a of def.actions) {
    if (!a.id || !/^[A-Za-z0-9_-]{1,64}$/.test(a.id)) throw new Error(`invalid action id: ${a.id}`);
    if (ids.has(a.id)) throw new Error(`duplicate action id: ${a.id}`);
    ids.add(a.id);
    if (!a.tool || a.tool === 'task' || a.tool === 'task_approve') throw new Error(`invalid task action tool: ${a.tool}`);
    if (a.agent) {
      const profile = getAgentProfile(a.agent);
      if (!profile) throw new Error(`unknown agent profile: ${a.agent}`);
      const scope = scopeOf(a.tool);
      if (scope && !profile.allowedScopes.includes(scope)) throw new Error(`agent ${a.agent} is not permitted to use ${a.tool}`);
      if (autonomyRank(def.autonomy) > autonomyRank(profile.defaultAutonomy)) throw new Error(`agent ${a.agent} cannot run at ${def.autonomy} autonomy`);
    }
    if (a.retries !== undefined && (!Number.isInteger(a.retries) || a.retries < 0 || a.retries > 5)) throw new Error(`invalid retries for ${a.id}`);
    if (a.timeoutMs !== undefined && (!Number.isInteger(a.timeoutMs) || a.timeoutMs < 100 || a.timeoutMs > 600_000)) throw new Error(`invalid timeout for ${a.id}`);
    for (const dep of a.dependsOn || []) if (!ids.has(dep) && !def.actions.some(x => x.id === dep)) throw new Error(`unknown dependency ${dep} for ${a.id}`);
  }
  const graph = new Map(def.actions.map(a => [a.id, a.dependsOn || []]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('task dependency graph contains a cycle');
    if (visited.has(id)) return;
    visiting.add(id); for (const dep of graph.get(id) || []) visit(dep); visiting.delete(id); visited.add(id);
  };
  for (const a of def.actions) visit(a.id);
}

function autonomyRank(value: AutonomyLevel): number { return ({ readonly: 0, safe: 1, supervised: 2, autonomous: 3 } as const)[value]; }

function isMutationLike(tool: string): boolean {
  return new Set(['write_file','edit_file','delete_path','run_command','kill_process','git','sqlite_query','allow_path','deny_path','package_install','package_remove','service_action','schedule_command','cancel_scheduled_task','workspace_snapshot','rollback_changes','run_background','job_cancel','run_parallel','upload_file','change_set_begin','change_set_add','change_set_commit','change_set_rollback','health_watch','health_stop','plugin_install','plugin_remove','context_snapshot','context_clear','approval_decide','task_approve']).has(tool);
}

export class TaskEngine {
  private readonly token: string;
  private readonly invoke: Invoke;
  private readonly dir: string;
  constructor(token: string, invoke: Invoke, options: { dataDirectory?: string } = {}) {
    this.token = token; this.invoke = invoke; this.dir = options.dataDirectory || dataDir();
  }

  create(def: TaskDefinition): TaskRecord {
    validate(def);
    const id = crypto.randomUUID();
    const created = now();
    const actions = def.actions.map(a => ({ ...clone(a), status: 'pending' as const, attempts: 0 }));
    const context: TaskContext = {
      taskId: id, goal: def.goal, autonomy: def.autonomy,
      budget: { total: 32_000, history: 4_000, tools: 12_000, memory: 8_000, reserved: 8_000 },
      facts: [], decisions: [], constraints: [], completedActions: [],
    };
    const row: TaskRecord = { id, tokenId: tokenId(this.token), goal: def.goal, autonomy: def.autonomy, state: def.dryRun ? 'completed' : 'queued', dryRun: Boolean(def.dryRun), createdAt: created, updatedAt: created, actions, context };
    if (def.dryRun) row.context.decisions.push('dry-run: no action executed');
    this.save(row);
    return clone(row);
  }

  get(id: string): TaskRecord | undefined {
    const row = load(this.dir).find(t => t.id === id && t.tokenId === tokenId(this.token));
    return row ? clone(row) : undefined;
  }
  list(limit = 20): TaskRecord[] { return load(this.dir).filter(t => t.tokenId === tokenId(this.token)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(100, Math.max(1, limit))).map(clone); }
  private save(row: TaskRecord): void { save([row], this.dir); }

  async approve(id: string): Promise<TaskRecord> {
    const row = this.require(id);
    if (row.state !== 'awaiting_approval') throw new Error(`task ${id} is not awaiting approval`);
    row.state = 'executing'; row.updatedAt = now(); row.approvalId = undefined; this.save(row);
    return this.execute(row);
  }

  reject(id: string): TaskRecord {
    const row = this.require(id);
    if (row.state !== 'awaiting_approval') throw new Error(`task ${id} is not awaiting approval`);
    row.state = 'cancelled'; row.error = 'task rejected during approval'; row.approvalId = undefined; row.updatedAt = now(); this.save(row);
    return clone(row);
  }

  async resume(id: string): Promise<TaskRecord> {
    const row = this.require(id);
    if (!['queued','executing','verifying','failed'].includes(row.state)) throw new Error(`task ${id} cannot be resumed from ${row.state}`);
    row.state = row.state === 'failed' ? 'planning' : row.state; row.updatedAt = now(); this.save(row);
    return this.execute(row);
  }

  private require(id: string): TaskRecord { const row = this.get(id); if (!row) throw new Error(`Task ${id} not found`); return row; }

  async run(id: string): Promise<TaskRecord> {
    const row = this.require(id);
    if (row.dryRun) return row;
    if (row.state !== 'queued' && row.state !== 'planning') throw new Error(`task ${id} cannot run from ${row.state}`);
    const hasMutation = row.actions.some(a => isMutationLike(a.tool));
    if (row.autonomy === 'readonly' && hasMutation) { row.state = 'failed'; row.error = 'readonly autonomy cannot execute mutating actions'; row.updatedAt = now(); this.save(row); return clone(row); }
    if (row.autonomy === 'supervised' && hasMutation) {
      row.state = 'awaiting_approval'; row.approvalId = `task-${crypto.randomUUID().slice(0,12)}`; row.updatedAt = now();
      row.context.decisions.push(`approval required: ${row.approvalId}`); this.save(row); return clone(row);
    }
    row.state = 'executing'; row.updatedAt = now(); this.save(row);
    return this.execute(row);
  }

  private async execute(row: TaskRecord): Promise<TaskRecord> {
    try {
      while (row.actions.some(a => a.status === 'pending' || a.status === 'running')) {
        const ready = row.actions.filter(a => a.status === 'pending' && (a.dependsOn || []).every(dep => {
          const status = row.actions.find(x => x.id === dep)?.status;
          if (a.condition === 'on_failure') return status === 'failed';
          if (a.condition === 'always') return ['succeeded','failed','skipped','rolled_back'].includes(status || '');
          return status === 'succeeded' || status === 'skipped';
        }));
        const blocked = row.actions.filter(a => a.status === 'pending' && (a.dependsOn || []).some(dep => {
          const status = row.actions.find(x => x.id === dep)?.status;
          return ['failed','rolled_back'].includes(status || '') && a.condition !== 'on_failure';
        }));
        for (const a of blocked) { a.status = 'skipped'; a.finishedAt = now(); }
        if (!ready.length) {
          if (row.actions.some(a => a.status === 'running')) { await new Promise(r => setTimeout(r, 10)); continue; }
          if (row.actions.some(a => a.status === 'pending')) throw new Error('task graph is blocked by unresolved dependencies');
          break;
        }
        row.state = 'executing'; row.updatedAt = now(); this.save(row);
        await Promise.all(ready.map(a => this.executeAction(row, a)));
        row.context.completedActions = row.actions.filter(a => a.status === 'succeeded').map(a => a.id);
        this.save(row);
      }
      row.state = 'verifying'; row.updatedAt = now(); this.save(row);
      const failed = row.actions.some(a => a.status === 'failed');
      if (failed) throw new Error('task verification failed');
      row.state = 'completed'; row.updatedAt = now(); this.save(row);
      return clone(row);
    } catch (e: any) {
      row.error = e?.message || String(e); row.state = 'failed'; row.updatedAt = now(); this.save(row);
      await this.rollback(row, row.actions.filter(a => a.status === 'succeeded'));
      return clone(row);
    }
  }

  private async executeAction(row: TaskRecord, action: TaskActionRecord): Promise<void> {
    action.status = 'running'; action.startedAt = now(); action.attempts += 1; this.save(row);
    const max = 1 + (action.retries || 0);
    while (action.attempts <= max) {
      try {
        const result = await withTimeout(this.invoke(action.tool, action.arguments || {}), action.timeoutMs || 600_000);
        if (result?.isError) throw new Error(extractText(result) || `tool ${action.tool} returned an error`);
        if (action.verify) {
          const verification = await withTimeout(this.invoke(action.verify.tool, action.verify.arguments || {}), action.timeoutMs || 600_000);
          if (verification?.isError) throw new Error(extractText(verification) || `verification failed for ${action.id}`);
          row.context.decisions.push(`verified: ${action.id} via ${action.verify.tool}`);
        }
        action.status = 'succeeded'; action.result = result; action.finishedAt = now(); this.save(row); return;
      } catch (e: any) {
        action.error = e?.message || String(e);
        if (action.attempts >= max) { action.status = 'failed'; action.finishedAt = now(); this.save(row); return; }
        action.attempts += 1; this.save(row);
      }
    }
  }

  private async rollback(row: TaskRecord, succeeded: TaskActionRecord[]): Promise<void> {
    row.context.decisions.push('rollback started after task failure');
    for (const action of [...succeeded].reverse()) {
      if (!action.rollback) continue;
      try { await withTimeout(this.invoke(action.rollback.tool, action.rollback.arguments || {}), action.timeoutMs || 600_000); action.status = 'rolled_back'; }
      catch (e: any) { row.context.decisions.push(`rollback failed for ${action.id}: ${e?.message || e}`); }
    }
    row.updatedAt = now(); this.save(row);
  }
}

export function taskSummary(row: TaskRecord): AgentResult<{ id: string; state: TaskState; actions: TaskActionRecord[] }> {
  return { ok: row.state === 'completed', summary: `Task ${row.id} is ${row.state}`, data: { id: row.id, state: row.state, actions: clone(row.actions) }, warnings: row.state === 'failed' ? [row.error || 'task failed'] : [], errors: row.state === 'failed' ? [row.error || 'task failed'] : [], nextActions: row.state === 'awaiting_approval' ? ['approve the task'] : row.state === 'failed' ? ['resume the task or inspect the failed action'] : [] };
}

function extractText(result: any): string { return Array.isArray(result?.content) ? result.content.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('\n').slice(0, 2000) : ''; }
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`action timed out after ${ms}ms`)), ms); promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); }); });
}
