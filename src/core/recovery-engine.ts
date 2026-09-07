import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './platform.js';

export interface RecoveryRule { id: string; tokenFingerprint: string; name: string; failureType: string; risk: 'low'|'medium'|'high'|'critical'; action: { tool: string; args: Record<string, unknown> }; enabled: boolean; maxAttempts: number; cooldownSeconds: number; attempts: number; lastAttempt?: string; }
export interface RecoveryIncident { id: string; tokenFingerprint: string; ruleId: string; failureType: string; status: 'open'|'recovered'|'failed'; created: string; updated: string; error?: string; }

const file = path.join(dataDir(), 'recovery.json');
const lock = `${file}.lock`;
const MAX_RULES = 200;
const MAX_INCIDENTS = 1000;
function fpRows(): { rules: RecoveryRule[]; incidents: RecoveryIncident[] } { try { const x = JSON.parse(fs.readFileSync(file, 'utf8')); return { rules: Array.isArray(x.rules) ? x.rules : [], incidents: Array.isArray(x.incidents) ? x.incidents : [] }; } catch { return { rules: [], incidents: [] }; } }
type RecoveryStore = { rules: RecoveryRule[]; incidents: RecoveryIncident[] };
function persist(mut: (x: RecoveryStore) => void): void {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const start = Date.now();
  while (true) { try { fs.mkdirSync(lock, { mode: 0o700 }); break; } catch (e: any) { if (e?.code !== 'EEXIST') throw e; try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch {} if (Date.now()-start > 5000) throw new Error('timed out waiting for recovery persistence lock'); const until = Date.now() + 10; while (Date.now() < until) {} } }
  try { const x = fpRows(); mut(x); const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ rules: x.rules.slice(-MAX_RULES), incidents: x.incidents.slice(-MAX_INCIDENTS) }, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
export function createRecoveryRule(rule: Omit<RecoveryRule, 'id'|'attempts'>): RecoveryRule { const out = { ...rule, id: crypto.randomUUID(), attempts: 0 }; persist(x => { if (x.rules.length >= MAX_RULES) throw new Error('recovery rule limit reached'); x.rules.push(out); }); return out; }
export function listRecoveryRules(token: string): RecoveryRule[] { return fpRows().rules.filter(r => r.tokenFingerprint === token); }
export function deleteRecoveryRule(token: string, id: string): boolean { let ok = false; persist(x => { const n = x.rules.filter(r => !(r.id === id && r.tokenFingerprint === token)); ok = n.length !== x.rules.length; x.rules = n; }); return ok; }
export function listIncidents(token: string): RecoveryIncident[] { return fpRows().incidents.filter(i => i.tokenFingerprint === token).sort((a,b) => b.updated.localeCompare(a.updated)); }
export function markIncident(token: string, rule: RecoveryRule, status: RecoveryIncident['status'], error?: string): void { persist(x => { const existing = x.incidents.find(i => i.ruleId === rule.id && i.tokenFingerprint === token && i.status === 'open'); const now = new Date().toISOString(); if (existing) { existing.status = status; existing.updated = now; existing.error = error; } else x.incidents.push({ id: crypto.randomUUID(), tokenFingerprint: token, ruleId: rule.id, failureType: rule.failureType, status, created: now, updated: now, error }); }); }
export function claimRecovery(token: string, id: string): RecoveryRule | undefined { let claimed: RecoveryRule | undefined; persist(x => { const r = x.rules.find(v => v.id === id && v.tokenFingerprint === token && v.enabled); if (!r) return; const now = Date.now(); if (r.attempts >= r.maxAttempts) return; if (r.lastAttempt && now - Date.parse(r.lastAttempt) < r.cooldownSeconds * 1000) return; r.attempts++; r.lastAttempt = new Date(now).toISOString(); claimed = { ...r }; }); return claimed; }
export function resetRecoveryAttempts(token: string, id: string): void { persist(x => { const r = x.rules.find(v => v.id === id && v.tokenFingerprint === token); if (r) r.attempts = 0; }); }

export function recoveryCandidates(token: string, failureType: string): RecoveryRule[] { return fpRows().rules.filter(r => r.enabled && r.tokenFingerprint === token && (r.failureType === failureType || r.failureType === '*')); }

export async function attemptRecoveryForFailure(token: string, failureType: string, invoke: (tool: string, args: Record<string, unknown>) => Promise<any>, authorize: (rule: RecoveryRule) => boolean): Promise<number> {
  let recovered = 0;
  for (const candidate of recoveryCandidates(token, failureType)) {
    if (!authorize(candidate)) continue;
    const claimed = claimRecovery(token, candidate.id);
    if (!claimed) continue;
    markIncident(token, claimed, 'open');
    try {
      const result = await invoke(claimed.action.tool, claimed.action.args);
      if (result?.isError) throw new Error('recovery action returned an error');
      markIncident(token, claimed, 'recovered');
      recovered++;
    } catch (e: any) {
      markIncident(token, claimed, 'failed', e?.message || String(e));
    }
  }
  return recovered;
}

export function clearRecoveryForTests(): void { try { fs.rmSync(file, { force: true }); } catch {} try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
