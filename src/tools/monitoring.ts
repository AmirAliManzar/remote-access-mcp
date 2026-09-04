import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertToolPermitted } from '../core/policy.js';
import { AuditLog } from '../core/audit.js';
import { dataDir } from '../core/platform.js';
import { notifyWebhooks } from '../core/webhooks.js';

interface WatchRecord {
  id: string;
  tokenFingerprint: string;
  intervalSeconds: number;
  cpuPercent?: number;
  memoryPercent?: number;
  created: string;
  ownerPid?: number;
}

const MAX_WATCHES = 500;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const timers = new Map<string, NodeJS.Timeout>();
let restored = false;

function storePath(): string { return path.join(dataDir(), 'health-watches.json'); }
function lockPath(): string { return path.join(dataDir(), 'health-watches.lock'); }
function isAlive(pid?: number): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try { process.kill(pid as number, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}
function load(): WatchRecord[] {
  try {
    const rows = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    if (!Array.isArray(rows)) throw new Error('invalid health watcher store');
    return rows.filter((r): r is WatchRecord => r && typeof r.id === 'string' && typeof r.tokenFingerprint === 'string' && Number.isInteger(r.intervalSeconds) && r.intervalSeconds >= 10 && r.intervalSeconds <= 3600 && typeof r.created === 'string');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw new Error(`failed to read health watcher store: ${e?.message || e}`);
  }
}
function withLock<T>(fn: () => T): T {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockPath(), { mode: 0o700 });
      try { return fn(); } finally { fs.rmSync(lockPath(), { recursive: true, force: true }); }
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lockPath()).mtimeMs > STALE_LOCK_MS) fs.rmSync(lockPath(), { recursive: true, force: true }); } catch { /* retry */ }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('timed out waiting for health watcher persistence lock');
      const until = Date.now() + 20;
      while (Date.now() < until) { /* synchronous lock acquisition */ }
    }
  }
}
function saveUnlocked(rows: WatchRecord[]): void {
  const target = storePath();
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify([...rows].sort((a, b) => a.created.localeCompare(b.created)).slice(-MAX_WATCHES), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}
function persist(mutator: (rows: WatchRecord[]) => void): WatchRecord[] {
  return withLock(() => { const rows = load(); mutator(rows); saveUnlocked(rows); return rows; });
}
function current(id: string, fingerprint: string): WatchRecord | undefined {
  return load().find(w => w.id === id && w.tokenFingerprint === fingerprint);
}
function stopLocal(key: string): void {
  const timer = timers.get(key);
  if (timer) clearInterval(timer);
  timers.delete(key);
}
function startLocal(w: WatchRecord, cfg: ToolContext['cfg']): void {
  const key = `${w.tokenFingerprint}:${w.id}`;
  stopLocal(key);
  const timer = setInterval(() => {
    const live = current(w.id, w.tokenFingerprint);
    if (!live || live.ownerPid !== process.pid) { stopLocal(key); return; }
    const cpu = os.loadavg()[0] / Math.max(1, os.cpus().length) * 100;
    const memory = (1 - os.freemem() / os.totalmem()) * 100;
    if ((live.cpuPercent !== undefined && cpu >= live.cpuPercent) || (live.memoryPercent !== undefined && memory >= live.memoryPercent)) {
      notifyWebhooks(cfg, { ts: Date.now(), token_fingerprint: w.tokenFingerprint, tool: 'health_watch', args_json: JSON.stringify({ cpu, memory }), ok: 0, is_error: 1, duration_ms: 0 });
    }
  }, w.intervalSeconds * 1000);
  timers.set(key, timer);
}
function restoreForProcess(cfg: ToolContext['cfg']): void {
  if (restored) return;
  restored = true;
  persist(rows => {
    for (const w of rows) if (!isAlive(w.ownerPid)) w.ownerPid = process.pid;
  }).filter(w => w.ownerPid === process.pid).forEach(w => startLocal(w, cfg));
}

export function registerMonitoringTools(server: McpServer, ctx: ToolContext): void {
  restoreForProcess(ctx.cfg);
  const tid = AuditLog.fingerprint(ctx.token.token);
  server.registerTool('health_watch', { description: 'Start a persistent periodic health watcher for CPU/memory thresholds. Alerts are emitted through configured webhooks and survive gateway restart.', inputSchema: { interval_seconds: z.number().min(10).max(3600).default(60), cpu_percent: z.number().min(1).max(100).optional(), memory_percent: z.number().min(1).max(100).optional() } }, async ({ interval_seconds, cpu_percent, memory_percent }) => {
    assertToolPermitted({ tool: 'health_watch', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const watcher: WatchRecord = { id: crypto.randomUUID().slice(0, 12), tokenFingerprint: tid, intervalSeconds: interval_seconds, cpuPercent: cpu_percent, memoryPercent: memory_percent, created: new Date().toISOString(), ownerPid: process.pid };
    persist(rows => rows.push(watcher));
    startLocal(watcher, ctx.cfg);
    return { content: [{ type: 'text', text: JSON.stringify({ id: watcher.id, interval_seconds }) }] };
  });
  server.registerTool('health_status', { description: 'List active persistent health watchers for the current token.', inputSchema: {} }, async () => {
    assertToolPermitted({ tool: 'health_status', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const rows = load().filter(w => w.tokenFingerprint === tid && isAlive(w.ownerPid));
    return { content: [{ type: 'text', text: JSON.stringify(rows.map(w => w.id)) }] };
  });
  server.registerTool('health_stop', { description: 'Stop a persistent health watcher.', inputSchema: { id: z.string() } }, async ({ id }) => {
    assertToolPermitted({ tool: 'health_stop', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const key = `${tid}:${id}`;
    const exists = current(id, tid);
    if (!exists) return { content: [{ type: 'text', text: 'Watcher not found.' }], isError: true };
    persist(rows => { const i = rows.findIndex(w => w.id === id && w.tokenFingerprint === tid); if (i >= 0) rows.splice(i, 1); });
    stopLocal(key);
    return { content: [{ type: 'text', text: `Stopped ${id}.` }] };
  });
}
