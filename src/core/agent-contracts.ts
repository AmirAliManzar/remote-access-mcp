/**
 * Stable contracts for the Agent Engine planned for 3.2+.
 *
 * This module intentionally contains types and small pure helpers only. It
 * does not execute tools, inspect the host, or alter existing request
 * semantics. Future Context/Router/Task layers build on these contracts.
 */

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type ExecutionMode = 'read' | 'mutate' | 'background' | 'interactive';
export type AutonomyLevel = 'readonly' | 'safe' | 'supervised' | 'autonomous';

export type TaskState =
  | 'queued'
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'rolled_back'
  | 'cancelled';

export interface AgentResult<T = unknown> {
  ok: boolean;
  summary: string;
  data?: T;
  warnings: string[];
  errors: string[];
  nextActions: string[];
  /** Approximate result size in UTF-8 bytes, when measured by the producer. */
  sizeBytes?: number;
  /** Optional identifier for a persisted/streamed result. */
  resultId?: string;
}

export interface CapabilityDescriptor {
  id: string;
  category: string;
  description: string;
  risk: RiskLevel;
  executionMode: ExecutionMode;
  requiredScopes: string[];
  contextCost: number;
  latencyHintMs?: number;
  dependencies: string[];
  supportsDryRun: boolean;
  supportsVerification: boolean;
}

export interface ContextBudget {
  total: number;
  history: number;
  tools: number;
  memory: number;
  reserved: number;
}

export interface TaskContext {
  taskId: string;
  goal: string;
  autonomy: AutonomyLevel;
  budget: ContextBudget;
  facts: string[];
  decisions: string[];
  constraints: string[];
  completedActions: string[];
}

export function createEmptyAgentResult<T>(summary: string, ok = true): AgentResult<T> {
  return { ok, summary, warnings: [], errors: [], nextActions: [] };
}

export function validateContextBudget(budget: ContextBudget): void {
  const values = [budget.total, budget.history, budget.tools, budget.memory, budget.reserved];
  if (values.some(v => !Number.isFinite(v) || v < 0)) {
    throw new Error('context budget values must be finite non-negative numbers');
  }
  const allocated = budget.history + budget.tools + budget.memory + budget.reserved;
  if (allocated > budget.total) {
    throw new Error('context budget allocations exceed total budget');
  }
}

const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ['planning', 'cancelled'],
  planning: ['awaiting_approval', 'executing', 'failed', 'cancelled'],
  awaiting_approval: ['executing', 'cancelled', 'failed'],
  executing: ['verifying', 'completed', 'failed', 'rolled_back', 'cancelled'],
  verifying: ['completed', 'failed', 'rolled_back', 'executing'],
  completed: [],
  failed: ['planning', 'executing', 'rolled_back', 'cancelled'],
  rolled_back: ['planning', 'cancelled'],
  cancelled: [],
};

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}
