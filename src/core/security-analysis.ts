import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dataDir } from './platform.js';
import { TOOL_SCOPES, MUTATING_TOOLS } from './policy.js';

export interface SecurityFinding { id: string; severity: 'info'|'low'|'medium'|'high'|'critical'; message: string; }
export interface SecurityReport { score: number; findings: SecurityFinding[]; checkedAt: string; }

function clamp(n: number): number { return Math.max(0, Math.min(100, n)); }

export function analyzeSecurity(input: { scopes: string[]; readOnly: boolean; shellEnabled: boolean; allowedPaths: string[]; deniedPaths: string[]; configDir?: string }): SecurityReport {
  const findings: SecurityFinding[] = [];
  const scopes = input.scopes;
  const mutating = Object.entries(TOOL_SCOPES).filter(([group, tools]) => (scopes.length === 0 || scopes.includes(group)) && tools.some(t => MUTATING_TOOLS.has(t))).map(([g]) => g);
  if (scopes.length === 0) findings.push({ id: 'broad-scope', severity: 'high', message: 'Token has unrestricted tool scopes.' });
  if (mutating.length && !input.readOnly) findings.push({ id: 'mutation-enabled', severity: mutating.includes('shell') ? 'high' : 'medium', message: `Mutating capability groups enabled: ${mutating.join(', ')}.` });
  if (input.shellEnabled && !input.readOnly && !input.allowedPaths.length) findings.push({ id: 'shell-without-paths', severity: 'medium', message: 'Shell is enabled while the filesystem allowlist is empty.' });
  if (!input.deniedPaths.length && input.allowedPaths.length) findings.push({ id: 'no-deny-paths', severity: 'low', message: 'No explicit denied paths are configured.' });
  const config = input.configDir || dataDir();
  try {
    const st = fs.statSync(config);
    if ((st.mode & 0o077) !== 0) findings.push({ id: 'data-dir-permissions', severity: 'high', message: `RAMCP data directory permissions are broader than 0700: ${((st.mode & 0o777).toString(8))}.` });
  } catch { findings.push({ id: 'data-dir-missing', severity: 'low', message: 'RAMCP data directory does not exist yet.' }); }
  const listeners = (() => { try { return os.networkInterfaces(); } catch { return {}; } })();
  const external = Object.values(listeners).flatMap(x => x || []).some(i => !i.internal);
  if (external) findings.push({ id: 'external-interface', severity: 'info', message: 'Host has non-loopback network interfaces; gateway binding should remain loopback.' });
  const penalty = findings.reduce((n, f) => n + ({ info: 0, low: 3, medium: 10, high: 25, critical: 50 } as const)[f.severity], 0);
  return { score: clamp(100 - penalty), findings, checkedAt: new Date().toISOString() };
}
