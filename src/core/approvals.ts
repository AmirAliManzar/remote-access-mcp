import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './platform.js';

export interface Approval {
  id: string;
  tokenId: string;
  command: string;
  cwd?: string;
  created: string;
  decided?: string;
  decidedBy?: string;
  consumed?: string;
  status: 'pending' | 'approved' | 'rejected' | 'consumed';
}

const MAX_ROWS = 2000;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

function storePath(): string { return path.join(dataDir(), 'approvals.json'); }
function lockPath(): string { return path.join(dataDir(), 'approvals.lock'); }

function load(): Approval[] {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error('invalid approvals store');
    return rows.filter((row): row is Approval => row && typeof row === 'object' && typeof row.id === 'string' && typeof row.tokenId === 'string' && typeof row.command === 'string' && typeof row.created === 'string' && ['pending', 'approved', 'rejected', 'consumed'].includes(row.status));
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw new Error(`failed to read approvals store: ${e?.message || e}`);
  }
}

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
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch { /* lock disappeared; retry */ }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('timed out waiting for approvals persistence lock');
      const until = Date.now() + 20;
      while (Date.now() < until) { /* synchronous lock acquisition */ }
    }
  }
}

function saveUnlocked(rows: Approval[]): void {
  const target = storePath();
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const retained = [...rows].sort((a, b) => a.created.localeCompare(b.created)).slice(-MAX_ROWS);
  fs.writeFileSync(tmp, JSON.stringify(retained, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}


export function requestApproval(tokenId: string, command: string, cwd?: string): Approval {
  const approval: Approval = {
    id: crypto.randomUUID().slice(0, 12), tokenId, command, cwd,
    created: new Date().toISOString(), status: 'pending',
  };
  withStoreLock(() => {
    const rows = load();
    rows.push(approval);
    saveUnlocked(rows);
  });
  return { ...approval };
}

export function getApproval(id: string, tokenId?: string): Approval | undefined {
  const approval = load().find(a => a.id === id);
  return approval && (!tokenId || approval.tokenId === tokenId) ? { ...approval } : undefined;
}

export function decideApproval(id: string, tokenId: string | undefined, approved: boolean, decidedBy = tokenId): Approval | undefined {
  return withStoreLock(() => {
    const rows = load();
    const index = rows.findIndex(a => a.id === id && (!tokenId || a.tokenId === tokenId));
    if (index < 0) return undefined;
    const current = rows[index];
    if (current.status !== 'pending') return { ...current };
    const updated: Approval = {
      ...current,
      status: approved ? 'approved' : 'rejected',
      decided: new Date().toISOString(),
      decidedBy,
    };
    rows[index] = updated;
    saveUnlocked(rows);
    return { ...updated };
  });
}

/** Atomically consume an approval. The approval is bound to the exact command and cwd. */
export function consumeApproval(id: string, tokenId: string, command: string, cwd?: string): Approval | undefined {
  return withStoreLock(() => {
    const rows = load();
    const index = rows.findIndex(a => a.id === id && a.tokenId === tokenId);
    if (index < 0) return undefined;
    const current = rows[index];
    if (current.status !== 'approved' || current.command !== command || current.cwd !== cwd) return undefined;
    const updated: Approval = { ...current, status: 'consumed', consumed: new Date().toISOString() };
    rows[index] = updated;
    saveUnlocked(rows);
    return { ...updated };
  });
}
