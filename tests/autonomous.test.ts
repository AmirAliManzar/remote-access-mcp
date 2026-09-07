import { describe, expect, it, afterEach } from 'vitest';
import { decideAutonomy } from '../src/core/autonomy.js';
import { analyzeSecurity } from '../src/core/security-analysis.js';
import { createRecoveryRule, clearRecoveryForTests, listRecoveryRules, claimRecovery, markIncident, listIncidents, attemptRecoveryForFailure } from '../src/core/recovery-engine.js';

afterEach(() => { clearRecoveryForTests(); delete process.env.RAMCP_AUTONOMOUS; delete process.env.RAMCP_AUTONOMOUS_HIGH_RISK; delete process.env.RAMCP_AUTONOMOUS_CRITICAL; });

describe('autonomy gate', () => {
  it('denies autonomous operations unless explicitly enabled', () => {
    expect(decideAutonomy('autonomous', 'low')).toBe('deny');
    expect(decideAutonomy('autonomous', 'high', { enabled: true })).toBe('approval_required');
    expect(decideAutonomy('autonomous', 'high', { enabled: true, allowAutonomousHighRisk: true })).toBe('allow');
    expect(decideAutonomy('autonomous', 'critical', { enabled: true, allowAutonomousCritical: true })).toBe('allow');
    expect(decideAutonomy('readonly', 'none')).toBe('allow');
    expect(decideAutonomy('readonly', 'low')).toBe('deny');
  });
});

describe('security analysis', () => {
  it('is bounded and read-only', () => {
    const report = analyzeSecurity({ scopes: [], readOnly: false, shellEnabled: true, allowedPaths: [], deniedPaths: [] });
    expect(report.score).toBeLessThan(100);
    expect(report.findings.some(f => f.id === 'broad-scope')).toBe(true);
    expect(report.findings.some(f => f.id === 'shell-without-paths')).toBe(true);
  });
});

describe('recovery engine', () => {
  it('isolates rules, claims once, and records incidents', () => {
    const a = createRecoveryRule({ tokenFingerprint: 'a', name: 'restart', failureType: 'service_action', risk: 'low', action: { tool: 'service_action', args: {} }, enabled: true, maxAttempts: 1, cooldownSeconds: 300 });
    createRecoveryRule({ tokenFingerprint: 'b', name: 'other', failureType: 'service_action', risk: 'low', action: { tool: 'service_status', args: {} }, enabled: true, maxAttempts: 1, cooldownSeconds: 300 });
    expect(listRecoveryRules('a')).toHaveLength(1);
    const claimed = claimRecovery('a', a.id);
    expect(claimed?.id).toBe(a.id);
    expect(claimRecovery('a', a.id)).toBeUndefined();
    markIncident('a', claimed!, 'open');
    markIncident('a', claimed!, 'recovered');
    expect(listIncidents('a')[0]?.status).toBe('recovered');
  });
  it('automatically recovers only authorized, claimed candidates', async () => {
    createRecoveryRule({ tokenFingerprint: 'a', name: 'fix', failureType: 'broken_tool', risk: 'low', action: { tool: 'safe_fix', args: {} }, enabled: true, maxAttempts: 2, cooldownSeconds: 30 });
    let calls = 0;
    const n = await attemptRecoveryForFailure('a', 'broken_tool', async () => { calls++; return { content: [{ type: 'text', text: 'ok' }] }; }, () => true);
    expect(n).toBe(1);
    expect(calls).toBe(1);
  });
});
