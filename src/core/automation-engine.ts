import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type { RamcpConfig } from './config.js';
import { dataDir } from './platform.js';
import { notifyWebhooks } from './webhooks.js';

export type TriggerType = 'interval' | 'file' | 'health' | 'webhook' | 'tool';
export type ConditionOp = 'equals' | 'not_equals' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';

export interface AutomationCondition {
  field: string;
  op: ConditionOp;
  value: string | number | boolean;
}

export interface AutomationAction {
  tool: string;
  args: Record<string, unknown>;
}

export interface AutomationRule {
  id: string;
  name: string;
  tokenFingerprint: string;
  enabled: boolean;
  trigger: { type: TriggerType; intervalSeconds?: number; path?: string; event?: string; tool?: string };
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  created: string;
  lastRun?: string;
  nextRun?: string;
  runs: number;
  failures: number;
}

export interface AutomationEvent {
  type: string;
  tool?: string;
  data?: Record<string, unknown>;
  tokenFingerprint?: string;
  ts: number;
  /** Prevent an automation action from recursively creating an infinite chain. */
  origin?: 'external' | 'automation';
  depth?: number;
}

const fileName = path.join(dataDir(), 'automations.json');
const lockName = path.join(dataDir(), 'automations.lock');
const executionLockDir = path.join(dataDir(), 'automation-executions');
const locks = new Set<string>();
const MAX_RULES = 1000;
const MAX_EVENT_DEPTH = 2;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30_000;
const STALE_EXECUTION_LOCK_MS = 10 * 60_000;
const MAX_FILE_TRIGGER_PATH = 2048;
const fileStates = new Map<string, { exists: boolean; mtimeMs: number; size: number }>();

function withFileLock<T>(fn: () => T): T {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockName, { mode: 0o700 });
      try { return fn(); } finally { fs.rmSync(lockName, { recursive: true, force: true }); }
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lockName).mtimeMs > STALE_LOCK_MS) fs.rmSync(lockName, { recursive: true, force: true });
      } catch { /* another process is racing us */ }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('timed out waiting for automation persistence lock');
      const until = Date.now() + 10;
      while (Date.now() < until) { /* bounded synchronous wait */ }
    }
  }
}

function loadAll(): AutomationRule[] {
  try {
    const raw = JSON.parse(fs.readFileSync(fileName, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('invalid automation store');
    return raw.filter((r): r is AutomationRule => Boolean(r && typeof r.id === 'string' && typeof r.name === 'string' && typeof r.tokenFingerprint === 'string' && typeof r.enabled === 'boolean' && r.trigger && typeof r.trigger.type === 'string' && Array.isArray(r.conditions) && Array.isArray(r.actions)));
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw new Error(`failed to read automation store: ${e?.message || e}`);
  }
}

function saveAll(rules: AutomationRule[]): void {
  fs.mkdirSync(path.dirname(fileName), { recursive: true, mode: 0o700 });
  const tmp = `${fileName}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rules.slice(-MAX_RULES), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, fileName);
}

function mutate(mutator: (rules: AutomationRule[]) => void): AutomationRule[] {
  return withFileLock(() => { const rules = loadAll(); mutator(rules); saveAll(rules); return rules; });
}

function claimExecution(ruleId: string): boolean {
  fs.mkdirSync(executionLockDir, { recursive: true, mode: 0o700 });
  const p = path.join(executionLockDir, `${ruleId}.lock`);
  try {
    fs.mkdirSync(p, { mode: 0o700 });
    fs.writeFileSync(path.join(p, 'owner'), `${process.pid}\n${Date.now()}\n`, { mode: 0o600 });
    return true;
  } catch (e: any) {
    if (e?.code !== 'EEXIST') return false;
    try { if (Date.now() - fs.statSync(p).mtimeMs > STALE_EXECUTION_LOCK_MS) { fs.rmSync(p, { recursive: true, force: true }); return claimExecution(ruleId); } } catch { /* another process owns it */ }
    return false;
  }
}

function releaseExecution(ruleId: string): void {
  try { fs.rmSync(path.join(executionLockDir, `${ruleId}.lock`), { recursive: true, force: true }); } catch { /* best effort */ }
}

export function tokenRules(tokenFingerprint: string): AutomationRule[] {
  return loadAll().filter(r => r.tokenFingerprint === tokenFingerprint);
}

export function automationPath(): string { return fileName; }
export function automationLockPath(): string { return lockName; }
export function clearAutomationRulesForTests(): void {
  try { fs.rmSync(fileName, { force: true }); } catch { /* test cleanup */ }
  try { fs.rmSync(lockName, { recursive: true, force: true }); } catch { /* test cleanup */ }
  try { fs.rmSync(executionLockDir, { recursive: true, force: true }); } catch { /* test cleanup */ }
  locks.clear();
  fileStates.clear();
}

export function createRule(rule: Omit<AutomationRule, 'id' | 'created' | 'runs' | 'failures'>): AutomationRule {
  const out: AutomationRule = { ...rule, id: crypto.randomUUID(), created: new Date().toISOString(), runs: 0, failures: 0 };
  mutate(all => {
    if (all.length >= MAX_RULES) throw new Error(`automation rule limit reached (${MAX_RULES})`);
    all.push(out);
  });
  return out;
}

export function deleteRule(tokenFingerprint: string, id: string): boolean {
  let changed = false;
  mutate(all => {
    const next = all.filter(r => !(r.tokenFingerprint === tokenFingerprint && r.id === id));
    changed = next.length !== all.length;
    all.splice(0, all.length, ...next);
  });
  return changed;
}

export function setRuleEnabled(tokenFingerprint: string, id: string, enabled: boolean): boolean {
  let changed = false;
  mutate(all => {
    const r = all.find(x => x.tokenFingerprint === tokenFingerprint && x.id === id);
    if (!r) return;
    r.enabled = enabled;
    if (!enabled) r.nextRun = undefined;
    changed = true;
  });
  return changed;
}

function compare(actual: unknown, op: ConditionOp, expected: string | number | boolean): boolean {
  switch (op) {
    case 'equals': return actual === expected;
    case 'not_equals': return actual !== expected;
    case 'contains': return String(actual).includes(String(expected));
    case 'gt': return Number(actual) > Number(expected);
    case 'gte': return Number(actual) >= Number(expected);
    case 'lt': return Number(actual) < Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
  }
}

export function matchesConditions(rule: AutomationRule, event: AutomationEvent): boolean {
  return rule.conditions.every(c => {
    const actual = c.field === 'type' ? event.type : c.field === 'tool' ? event.tool : event.data?.[c.field];
    return actual !== undefined && compare(actual, c.op, c.value);
  });
}

function triggerMatches(rule: AutomationRule, event: AutomationEvent): boolean {
  switch (rule.trigger.type) {
    case 'tool': return !rule.trigger.tool || rule.trigger.tool === event.tool;
    case 'webhook': return !rule.trigger.event || rule.trigger.event === event.type;
    case 'health': return !rule.trigger.event || rule.trigger.event === event.type;
    case 'file': return !rule.trigger.path || rule.trigger.path === String(event.data?.path || '');
    case 'interval': return false;
  }
}

function shouldAcceptEvent(event: AutomationEvent): boolean {
  const depth = event.depth ?? 0;
  return depth <= MAX_EVENT_DEPTH && event.origin !== 'automation';
}

async function executeRule(
  rule: AutomationRule,
  event: AutomationEvent,
  execute: (rule: AutomationRule, action: AutomationAction) => Promise<void>,
  cfg?: RamcpConfig,
  persistStats = true,
): Promise<'success' | 'failure' | 'skipped'> {
  if (locks.has(rule.id) || !shouldAcceptEvent(event) || !claimExecution(rule.id)) return 'skipped';
  locks.add(rule.id);
  let result: 'success' | 'failure' = 'success';
  try {
    for (const action of rule.actions) await execute(rule, action);
  } catch {
    result = 'failure';
  } finally {
    locks.delete(rule.id);
    releaseExecution(rule.id);
  }
  if (persistStats) {
    mutate(all => {
      const current = all.find(r => r.id === rule.id && r.tokenFingerprint === rule.tokenFingerprint);
      if (!current) return;
      if (result === 'success') current.runs++; else current.failures++;
      current.lastRun = new Date().toISOString();
    });
  }
  if (cfg) notifyWebhooks(cfg, { ts: Date.now(), token_fingerprint: rule.tokenFingerprint, tool: 'automation', args_json: JSON.stringify({ rule: rule.id, event: event.type }), ok: result === 'success' ? 1 : 0, is_error: result === 'failure' ? 1 : 0, duration_ms: 0 });
  return result;
}

export async function dispatchAutomationEvent(event: AutomationEvent, execute: (rule: AutomationRule, action: AutomationAction) => Promise<void>, cfg?: RamcpConfig): Promise<void> {
  if (!event.tokenFingerprint || !shouldAcceptEvent(event)) return;
  const rules = tokenRules(event.tokenFingerprint);
  const matches = rules.filter(r => r.enabled && triggerMatches(r, event) && matchesConditions(r, event));
  const results = await Promise.all(matches.map(r => executeRule(r, event, execute, cfg, false)));
  const completed = results.map((result, i) => ({ result, rule: matches[i] })).filter(x => x.result !== 'skipped');
  if (completed.length) {
    mutate(all => {
      const now = new Date().toISOString();
      for (const { result, rule } of completed) {
        const current = all.find(r => r.id === rule.id && r.tokenFingerprint === rule.tokenFingerprint);
        if (!current) continue;
        if (result === 'success') current.runs++; else current.failures++;
        current.lastRun = now;
      }
    });
  }
}

function statFile(p: string): { exists: boolean; mtimeMs: number; size: number } {
  try { const s = fs.statSync(p); return { exists: true, mtimeMs: s.mtimeMs, size: s.size }; }
  catch { return { exists: false, mtimeMs: 0, size: 0 }; }
}

function scanFileRules(rules: AutomationRule[], execute: (rule: AutomationRule, action: AutomationAction) => Promise<void>, cfg?: RamcpConfig): void {
  for (const rule of rules) {
    if (!rule.enabled || rule.trigger.type !== 'file' || !rule.trigger.path || rule.trigger.path.length > MAX_FILE_TRIGGER_PATH || locks.has(rule.id)) continue;
    const p = path.resolve(rule.trigger.path);
    const now = statFile(p);
    const previous = fileStates.get(rule.id);
    fileStates.set(rule.id, now);
    if (previous && (previous.exists !== now.exists || previous.mtimeMs !== now.mtimeMs || previous.size !== now.size)) {
      void executeRule(rule, { type: 'file.change', data: { path: p, exists: now.exists, size: now.size, mtimeMs: now.mtimeMs }, tokenFingerprint: rule.tokenFingerprint, ts: Date.now() }, execute, cfg);
    }
  }
}

function scanHealthRules(rules: AutomationRule[], execute: (rule: AutomationRule, action: AutomationAction) => Promise<void>, cfg?: RamcpConfig): void {
  const cpu = os.loadavg()[0] / Math.max(1, os.cpus().length) * 100;
  const memory = (1 - os.freemem() / os.totalmem()) * 100;
  for (const rule of rules) {
    if (!rule.enabled || rule.trigger.type !== 'health' || locks.has(rule.id)) continue;
    const event: AutomationEvent = { type: rule.trigger.event || 'health.sample', data: { cpu, memory }, tokenFingerprint: rule.tokenFingerprint, ts: Date.now() };
    if (matchesConditions(rule, event)) void executeRule(rule, event, execute, cfg);
  }
}

export function startAutomationEngine(execute: (rule: AutomationRule, action: AutomationAction) => Promise<void>, cfg?: RamcpConfig): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now();
    let rules: AutomationRule[];
    try { rules = loadAll(); } catch { return; }
    scanFileRules(rules, execute, cfg);
    scanHealthRules(rules, execute, cfg);
    for (const rule of rules) {
      if (!rule.enabled || rule.trigger.type !== 'interval' || !rule.trigger.intervalSeconds || locks.has(rule.id)) continue;
      const next = rule.nextRun ? Date.parse(rule.nextRun) : now;
      if (!Number.isFinite(next) || next > now) continue;
      if (!claimExecution(rule.id)) continue;
      locks.add(rule.id);
      void (async () => {
        try {
          for (const action of rule.actions) await execute(rule, action);
          mutate(all => { const current = all.find(r => r.id === rule.id && r.tokenFingerprint === rule.tokenFingerprint); if (current) current.runs++; });
        } catch {
          mutate(all => { const current = all.find(r => r.id === rule.id && r.tokenFingerprint === rule.tokenFingerprint); if (current) current.failures++; });
        } finally {
          mutate(all => { const current = all.find(r => r.id === rule.id && r.tokenFingerprint === rule.tokenFingerprint); if (current) { current.lastRun = new Date().toISOString(); current.nextRun = new Date(Date.now() + rule.trigger.intervalSeconds! * 1000).toISOString(); } });
          locks.delete(rule.id);
          releaseExecution(rule.id);
        }
      })();
    }
  }, 1000);
  return timer;
}
