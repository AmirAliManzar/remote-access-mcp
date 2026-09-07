import { describe, expect, it } from 'vitest';
import {
  canTransitionTask,
  createEmptyAgentResult,
  validateContextBudget,
} from '../src/core/agent-contracts.js';

describe('agent contracts', () => {
  it('creates a normalized empty result', () => {
    expect(createEmptyAgentResult('done')).toEqual({
      ok: true,
      summary: 'done',
      warnings: [],
      errors: [],
      nextActions: [],
    });
  });

  it('rejects invalid or over-allocated context budgets', () => {
    expect(() => validateContextBudget({ total: 10, history: 4, tools: 3, memory: 2, reserved: 1 })).not.toThrow();
    expect(() => validateContextBudget({ total: 10, history: 8, tools: 3, memory: 0, reserved: 0 })).toThrow();
    expect(() => validateContextBudget({ total: 10, history: -1, tools: 0, memory: 0, reserved: 0 })).toThrow();
    expect(() => validateContextBudget({ total: Infinity, history: 0, tools: 0, memory: 0, reserved: 0 })).toThrow();
  });

  it('enforces the task lifecycle instead of allowing arbitrary jumps', () => {
    expect(canTransitionTask('queued', 'planning')).toBe(true);
    expect(canTransitionTask('planning', 'executing')).toBe(true);
    expect(canTransitionTask('executing', 'verifying')).toBe(true);
    expect(canTransitionTask('verifying', 'executing')).toBe(true);
    expect(canTransitionTask('completed', 'executing')).toBe(false);
    expect(canTransitionTask('queued', 'completed')).toBe(false);
  });
});
