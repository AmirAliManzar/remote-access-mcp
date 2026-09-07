import { MUTATING_TOOLS, scopeOf, TOOL_SCOPES } from './policy.js';
import type { CapabilityDescriptor, ExecutionMode, RiskLevel } from './agent-contracts.js';

export interface CapabilityQuery {
  query?: string;
  category?: string;
  maxCost?: number;
  limit?: number;
}

const READ_RISK: Record<string, RiskLevel> = {
  filesystem: 'low', shell: 'medium', system: 'none', http: 'low', git: 'low',
  sqlite: 'medium', policy: 'medium', logs: 'low', services: 'medium', packages: 'medium',
  schedule: 'medium', automation: 'medium', project: 'low', security: 'low', planning: 'medium', formatting: 'low',
  documents: 'low', ops: 'low', jobs: 'medium', transfer: 'medium', diagnostics: 'low',
  monitoring: 'low', database: 'medium', changes: 'high', resources: 'low', prompts: 'none',
  plugins: 'high', approvals: 'high', integrations: 'medium', browser: 'low', infrastructure: 'medium', context: 'low',
};

const MUTATING_RISK: RiskLevel = 'high';

/**
 * Static capability catalog derived from the policy's authoritative tool groups.
 * This keeps discovery deterministic and does not execute or inspect the host.
 */
export function capabilityCatalog(): CapabilityDescriptor[] {
  const out: CapabilityDescriptor[] = [];
  for (const [category, tools] of Object.entries(TOOL_SCOPES)) {
    for (const id of tools) {
      const mutating = MUTATING_TOOLS.has(id);
      const risk = mutating ? MUTATING_RISK : (READ_RISK[category] || 'low');
      const executionMode: ExecutionMode = id === 'run_background' || id === 'run_parallel'
        ? 'background' : mutating ? 'mutate' : 'read';
      out.push({
        id,
        category,
        description: `${id.replace(/_/g, ' ')} capability`,
        risk,
        executionMode,
        requiredScopes: [category],
        contextCost: contextCost(id, category),
        latencyHintMs: latencyHint(id),
        dependencies: [],
        supportsDryRun: mutating && ['git', 'service_action', 'package_install', 'package_remove', 'change_set_commit', 'change_set_rollback'].includes(id),
        supportsVerification: mutating || ['project_health_check', 'system_diagnostics', 'health_status'].includes(id),
      });
    }
  }
  return out;
}

export function authorizedCapabilities(scopes: string[], query: CapabilityQuery = {}): CapabilityDescriptor[] {
  const all = capabilityCatalog();
  const canSee = (c: CapabilityDescriptor) => scopes.length === 0 || scopes.includes(c.id) || scopes.includes(c.category);
  const q = query.query?.trim().toLowerCase();
  return all.filter(c => canSee(c))
    .filter(c => !query.category || c.category === query.category)
    .filter(c => query.maxCost === undefined || c.contextCost <= query.maxCost)
    .filter(c => !q || `${c.id} ${c.category} ${c.description}`.toLowerCase().includes(q))
    .sort((a, b) => a.contextCost - b.contextCost || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, Math.min(query.limit ?? 32, 128)));
}

export function isToolAuthorized(tool: string, scopes: string[]): boolean {
  if (scopes.length === 0) return true;
  const group = scopeOf(tool);
  if (scopes.includes(tool) || (group !== null && scopes.includes(group))) return true;
  // Integration tools are discovered dynamically from their upstream MCP.
  // Keep them behind the explicit integrations scope without hard-coding the
  // upstream tool list into the core catalog.
  return (tool.startsWith('context7_') || tool.startsWith('codebase_memory_')) && scopes.includes('integrations');
}

function contextCost(id: string, category: string): number {
  if (id === 'download_file' || id === 'job_output' || id === 'read_file') return 5;
  if (category === 'system' || category === 'resources') return 1;
  if (category === 'logs' || category === 'database' || category === 'git') return 3;
  if (id.includes('scan') || id.includes('diagnos')) return 4;
  return 2;
}

function latencyHint(id: string): number {
  if (id === 'run_background' || id === 'run_parallel') return 50;
  if (id.includes('scan') || id.includes('diagnos') || id === 'analyze_project') return 500;
  return 20;
}

export function capabilityCategories(): string[] {
  return Object.keys(TOOL_SCOPES);
}
