import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dataDir, childEnv, shellCommand } from './platform.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
export interface JobRecord {
  id: string; command: string; cwd?: string; status: JobStatus; created: string; started?: string; finished?: string;
  exitCode?: number | null; signal?: string | null; output: string; truncated: boolean; error?: string; tokenId: string; timeoutMs: number; attempts: number; maxAttempts: number; ownerId?: string; ownerPid?: number;
}

const MAX_OUTPUT = 200_000;
function storePath(): string { return path.join(dataDir(), 'jobs.json'); }
function lockPath(): string { return path.join(dataDir(), 'jobs.lock'); }
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

function load(): JobRecord[] {
  try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')) as JobRecord[]; } catch { return []; }
}

/**
 * Cross-process persistence lock. mkdir is atomic on local filesystems, so two
 * gateway processes cannot perform a read/merge/write at the same time.
 * A stale lock is recoverable after an owner crash.
 */
function withStoreLock<T>(fn: () => T): T {
  const dir = path.dirname(storePath());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = lockPath();
  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      try { return fn(); }
      finally { fs.rmSync(lock, { recursive: true, force: true }); }
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > 30_000) fs.rmSync(lock, { recursive: true, force: true });
      } catch { /* another process may be replacing/removing the lock */ }
      if (Date.now() - started > 10_000) throw new Error('timed out waiting for jobs persistence lock');
      const until = Date.now() + 20;
      while (Date.now() < until) { /* synchronous backoff keeps the critical section simple */ }
    }
  }
}

function saveMerged(changed: JobRecord[]): void {
  withStoreLock(() => {
    const current = new Map(load().map(j => [j.id, j]));
    for (const job of changed) current.set(job.id, { ...job });
    const rows = [...current.values()].sort((a, b) => a.created.localeCompare(b.created)).slice(-500);
    const target = storePath();
    const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
  });
}

export class JobManager {
  private jobs = new Map<string, JobRecord>();
  private running = 0;
  private queue: string[] = [];
  private dirty = new Set<string>();
  private readonly maxWorkers: number;
  private readonly workerId = randomUUID();
  constructor(maxWorkers = Math.max(2, Math.min(8, Number(process.env.RAMCP_WORKERS || 4)))) {
    this.maxWorkers = maxWorkers;
    for (const j of load()) {
      if (j.status === 'running') {
        const ownerAlive = typeof j.ownerPid === 'number' && isProcessAlive(j.ownerPid);
        if (!ownerAlive) { j.status = 'queued'; j.started = undefined; j.finished = undefined; j.ownerId = undefined; j.ownerPid = undefined; this.markDirty(j.id); }
      }
      this.jobs.set(j.id, j);
      if (j.status === 'queued' && (!j.ownerId || j.ownerId === this.workerId)) this.queue.push(j.id);
    }
    this.persist();
    this.pump();
  }
  create(command: string, tokenId: string, cwd?: string, timeoutMs = 600_000, maxAttempts = 1): JobRecord {
    const j: JobRecord = { id: randomUUID(), command, cwd, status: 'queued', created: new Date().toISOString(), output: '', truncated: false, tokenId, timeoutMs: Math.min(Math.max(1000, timeoutMs), 600_000), attempts: 0, maxAttempts: Math.min(Math.max(1, maxAttempts), 5), ownerId: this.workerId, ownerPid: process.pid };
    this.jobs.set(j.id, j); this.queue.push(j.id); this.markDirty(j.id); this.persist(); this.pump(); return j;
  }
  get(id: string, tokenId?: string): JobRecord | undefined { this.refresh(); const j = this.jobs.get(id); return j && (!tokenId || j.tokenId === tokenId) ? { ...j } : undefined; }
  list(tokenId?: string): JobRecord[] { this.refresh(); return [...this.jobs.values()].filter(j => !tokenId || j.tokenId === tokenId).sort((a,b) => b.created.localeCompare(a.created)).map(j => ({ ...j })); }
  cancel(id: string, tokenId: string): boolean {
    const j = this.jobs.get(id); if (!j || j.tokenId !== tokenId) return false;
    if (j.status === 'queued') { j.status = 'cancelled'; j.finished = new Date().toISOString(); this.queue = this.queue.filter(x => x !== id); this.markDirty(id); this.persist(); return true; }
    const child = (j as any).__child as ReturnType<typeof spawn> | undefined;
    if (child && j.status === 'running') child.kill('SIGTERM'); else return false;
    return true;
  }
  shutdown(): void { for (const j of this.jobs.values()) { const child = (j as any).__child; if (child) child.kill('SIGTERM'); } }
  private pump(): void {
    while (this.running < this.maxWorkers && this.queue.length) {
      const id = this.queue.shift()!; const j = this.jobs.get(id); if (!j || j.status !== 'queued') continue;
      this.running++; j.status = 'running'; j.started = new Date().toISOString(); j.ownerId = this.workerId; j.ownerPid = process.pid; this.markDirty(id); this.persist();
      const { file, args } = shellCommand(j.command);
      j.attempts++;
      this.markDirty(j.id);
      this.persist();
      const child = spawn(file, args, { cwd: j.cwd || undefined, env: childEnv(), windowsHide: true });
      (j as any).__child = child;
      const timer = setTimeout(() => { (j as any).__timedOut = true; child.kill('SIGTERM'); }, j.timeoutMs);
      const append = (chunk: Buffer | string) => { if (j.output.length >= MAX_OUTPUT) { j.truncated = true; return; } const s = String(chunk); const room = MAX_OUTPUT - j.output.length; j.output += s.slice(0, room); if (s.length > room) j.truncated = true; this.markDirty(j.id); this.persist(); };
      child.stdout.on('data', append); child.stderr.on('data', x => append(`\n--- stderr ---\n${x}`));
      child.on('error', e => { j.error = e.message; this.markDirty(j.id); this.persist(); });
      child.on('close', (code, signal) => {
        clearTimeout(timer); delete (j as any).__child; j.exitCode = code; j.signal = signal;
        if ((j as any).__timedOut) { delete (j as any).__timedOut; j.status = 'timed_out'; j.error = `Job timed out after ${j.timeoutMs}ms`; }
        else if (signal === 'SIGTERM' && !code) j.status = 'cancelled';
        else if (code === 0) j.status = 'succeeded';
        else if (j.attempts < j.maxAttempts) { j.status = 'queued'; this.queue.push(j.id); }
        else j.status = 'failed';
        j.finished = j.status === 'queued' ? undefined : new Date().toISOString();
        if (j.status !== 'queued') { j.ownerId = undefined; j.ownerPid = undefined; }
        if (!j.output) j.output = '(no output)';
        this.running--; this.markDirty(j.id); this.persist(); this.pump();
      });
    }
  }

  private refresh(): void {
    for (const diskJob of load()) {
      const local = this.jobs.get(diskJob.id);
      if (!local || local.ownerId !== this.workerId || local.status !== 'running') this.jobs.set(diskJob.id, diskJob);
    }
  }

  private markDirty(id: string): void { this.dirty.add(id); }
  private persist(): void {
    if (!this.dirty.size) return;
    const changed: JobRecord[] = [];
    for (const id of this.dirty) {
      const j = this.jobs.get(id);
      if (j) { const c = { ...j }; delete (c as any).__child; delete (c as any).__timedOut; changed.push(c); }
    }
    this.dirty.clear();
    try { saveMerged(changed); }
    catch (e) { for (const j of changed) this.dirty.add(j.id); throw e; }
  }
}

export const jobManager = new JobManager();
