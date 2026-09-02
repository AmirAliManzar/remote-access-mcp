import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dataDir, childEnv, shellCommand } from './platform.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
export interface JobRecord {
  id: string; command: string; cwd?: string; status: JobStatus; created: string; started?: string; finished?: string;
  exitCode?: number | null; signal?: string | null; output: string; truncated: boolean; error?: string; tokenId: string; timeoutMs: number; attempts: number; maxAttempts: number;
}

const MAX_OUTPUT = 200_000;
const STORE = path.join(dataDir(), 'jobs.json');

function load(): JobRecord[] { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return []; } }
function save(rows: JobRecord[]): void { fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, JSON.stringify(rows.slice(-500), null, 2), { mode: 0o600 }); }

export class JobManager {
  private jobs = new Map<string, JobRecord>();
  private running = 0;
  private queue: string[] = [];
  private readonly maxWorkers: number;
  constructor(maxWorkers = Math.max(2, Math.min(8, Number(process.env.RAMCP_WORKERS || 4)))) {
    this.maxWorkers = maxWorkers;
    for (const j of load()) {
      if (j.status === 'running') { j.status = 'queued'; j.started = undefined; j.finished = undefined; }
      this.jobs.set(j.id, j);
      if (j.status === 'queued') this.queue.push(j.id);
    }
    this.pump();
  }
  create(command: string, tokenId: string, cwd?: string, timeoutMs = 600_000, maxAttempts = 1): JobRecord {
    const j: JobRecord = { id: randomUUID(), command, cwd, status: 'queued', created: new Date().toISOString(), output: '', truncated: false, tokenId, timeoutMs: Math.min(Math.max(1000, timeoutMs), 600_000), attempts: 0, maxAttempts: Math.min(Math.max(1, maxAttempts), 5) };
    this.jobs.set(j.id, j); this.queue.push(j.id); this.persist(); this.pump(); return j;
  }
  get(id: string, tokenId?: string): JobRecord | undefined { const j = this.jobs.get(id); return j && (!tokenId || j.tokenId === tokenId) ? { ...j } : undefined; }
  list(tokenId?: string): JobRecord[] { return [...this.jobs.values()].filter(j => !tokenId || j.tokenId === tokenId).sort((a,b) => b.created.localeCompare(a.created)).map(j => ({ ...j })); }
  cancel(id: string, tokenId: string): boolean {
    const j = this.jobs.get(id); if (!j || j.tokenId !== tokenId) return false;
    if (j.status === 'queued') { j.status = 'cancelled'; j.finished = new Date().toISOString(); this.queue = this.queue.filter(x => x !== id); this.persist(); return true; }
    const child = (j as any).__child as ReturnType<typeof spawn> | undefined;
    if (child && j.status === 'running') child.kill('SIGTERM'); else return false;
    return true;
  }
  shutdown(): void { for (const j of this.jobs.values()) { const child = (j as any).__child; if (child) child.kill('SIGTERM'); } }
  private pump(): void {
    while (this.running < this.maxWorkers && this.queue.length) {
      const id = this.queue.shift()!; const j = this.jobs.get(id); if (!j || j.status !== 'queued') continue;
      this.running++; j.status = 'running'; j.started = new Date().toISOString(); this.persist();
      const { file, args } = shellCommand(j.command);
      j.attempts++;
      const child = spawn(file, args, { cwd: j.cwd || undefined, env: childEnv(), windowsHide: true });
      (j as any).__child = child;
      const timer = setTimeout(() => { (j as any).__timedOut = true; child.kill('SIGTERM'); }, j.timeoutMs);
      const append = (chunk: Buffer | string) => { if (j.output.length >= MAX_OUTPUT) { j.truncated = true; return; } const s = String(chunk); const room = MAX_OUTPUT - j.output.length; j.output += s.slice(0, room); if (s.length > room) j.truncated = true; this.persist(); };
      child.stdout.on('data', append); child.stderr.on('data', x => append(`\n--- stderr ---\n${x}`));
      child.on('error', e => { j.error = e.message; });
      child.on('close', (code, signal) => {
        clearTimeout(timer); delete (j as any).__child; j.exitCode = code; j.signal = signal;
        if ((j as any).__timedOut) { delete (j as any).__timedOut; j.status = 'timed_out'; j.error = `Job timed out after ${j.timeoutMs}ms`; }
        else if (signal === 'SIGTERM' && !code) j.status = 'cancelled';
        else if (code === 0) j.status = 'succeeded';
        else if (j.attempts < j.maxAttempts) { j.status = 'queued'; this.queue.push(j.id); }
        else j.status = 'failed';
        j.finished = j.status === 'queued' ? undefined : new Date().toISOString(); if (!j.output) j.output = '(no output)';
        this.running--; this.persist(); this.pump();
      });
    }
  }
  private persist(): void { save([...this.jobs.values()].map(j => { const c = { ...j }; delete (c as any).__child; return c; })); }
}

export const jobManager = new JobManager();
