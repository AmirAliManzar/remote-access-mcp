import type { AutonomyLevel, RiskLevel } from './agent-contracts.js';

const rank: Record<AutonomyLevel, number> = { readonly: 0, safe: 1, supervised: 2, autonomous: 3 };
const riskRank: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

export interface AutonomyPolicy {
  enabled?: boolean;
  allowAutonomousHighRisk?: boolean;
  allowAutonomousCritical?: boolean;
}

export type AutonomyDecision = 'allow' | 'approval_required' | 'deny';

/** Centralized autonomy gate. It is intentionally stricter than the legacy task engine. */
export function decideAutonomy(level: AutonomyLevel, risk: RiskLevel, policy: AutonomyPolicy = {}): AutonomyDecision {
  if (level === 'readonly') return risk === 'none' ? 'allow' : 'deny';
  if (risk === 'critical') {
    if (level === 'supervised' && policy.enabled === true) return 'approval_required';
    if (level === 'autonomous' && policy.enabled === true && policy.allowAutonomousCritical === true) return 'allow';
    return 'deny';
  }
  if (level === 'safe') return riskRank[risk] <= riskRank.low ? 'allow' : 'approval_required';
  if (level === 'supervised') return riskRank[risk] <= riskRank.low ? 'allow' : 'approval_required';
  if (level === 'autonomous') {
    if (policy.enabled !== true) return 'deny';
    if (risk === 'high' && policy.allowAutonomousHighRisk !== true) return 'approval_required';
    return 'allow';
  }
  return 'deny';
}

export function autonomyAtLeast(actual: AutonomyLevel, required: AutonomyLevel): boolean {
  return rank[actual] >= rank[required];
}
