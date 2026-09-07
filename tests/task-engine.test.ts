import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { TaskEngine } from '../src/core/task-engine.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-task-'));

function engine(calls: string[] = [], behavior: Record<string, unknown> = {}) {
  return new TaskEngine('task-test-token', async (name, args) => {
    calls.push(`${name}:${JSON.stringify(args)}`);
    const value = behavior[name];
    if (typeof value === 'function') return (value as any)(args);
    if (value instanceof Error) return { content: [{ type: 'text', text: value.message }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(value ?? { ok: true }) }] };
  }, { dataDirectory: root });
}

describe('TaskEngine', () => {
  it('executes independent actions in parallel and persists completion', async () => {
    const calls: string[] = [];
    const e = engine(calls);
    const row = e.create({ goal: 'parallel', autonomy: 'safe', actions: [
      { id: 'a', tool: 'read_file', arguments: { path: '/tmp/a' } },
      { id: 'b', tool: 'system_info' },
    ] });
    const result = await e.run(row.id);
    expect(result.state).toBe('completed');
    expect(result.actions.every(a => a.status === 'succeeded')).toBe(true);
    expect(calls).toHaveLength(2);
    expect(e.get(row.id)?.state).toBe('completed');
  });

  it('honors dependency ordering', async () => {
    const calls: string[] = [];
    const e = engine(calls);
    const row = e.create({ goal: 'ordered', autonomy: 'safe', actions: [
      { id: 'first', tool: 'system_info' },
      { id: 'second', tool: 'system_resource', dependsOn: ['first'] },
    ] });
    const result = await e.run(row.id);
    expect(result.state).toBe('completed');
    expect(calls[0].startsWith('system_info')).toBe(true);
    expect(calls[1].startsWith('system_resource')).toBe(true);
  });

  it('rejects cyclic graphs', () => {
    const e = engine();
    expect(() => e.create({ goal: 'cycle', autonomy: 'safe', actions: [
      { id: 'a', tool: 'system_info', dependsOn: ['b'] },
      { id: 'b', tool: 'system_info', dependsOn: ['a'] },
    ] })).toThrow(/cycle/);
  });

  it('supports retries and fails durably after exhaustion', async () => {
    let n = 0;
    const e = engine([], { flaky: () => {
      n += 1;
      if (n < 3) return { content: [{ type: 'text', text: 'no' }], isError: true };
      return { content: [{ type: 'text', text: 'yes' }] };
    }});
    const row = e.create({ goal: 'retry', autonomy: 'safe', actions: [{ id: 'x', tool: 'flaky', retries: 2 }] });
    const result = await e.run(row.id);
    expect(result.state).toBe('completed');
    expect(result.actions[0].attempts).toBe(3);
  });

  it('pauses supervised mutation tasks for approval', async () => {
    const calls: string[] = [];
    const e = engine(calls);
    const row = e.create({ goal: 'approval', autonomy: 'supervised', actions: [{ id: 'x', tool: 'write_file', arguments: { path: '/tmp/x' } }] });
    const pending = await e.run(row.id);
    expect(pending.state).toBe('awaiting_approval');
    expect(calls).toHaveLength(0);
    const approved = await e.approve(row.id);
    expect(approved.state).toBe('completed');
    expect(calls).toHaveLength(1);
  });

  it('can reject a supervised task without executing it', async () => {
    const calls: string[] = [];
    const e = engine(calls);
    const row = e.create({ goal: 'reject', autonomy: 'supervised', actions: [{ id: 'x', tool: 'write_file' }] });
    const pending = await e.run(row.id);
    expect(pending.state).toBe('awaiting_approval');
    const rejected = e.reject(row.id);
    expect(rejected.state).toBe('cancelled');
    expect(calls).toHaveLength(0);
  });

  it('allows readonly autonomy to execute read-only actions but refuses mutation', async () => {
    const e = engine();
    const read = e.create({ goal: 'read', autonomy: 'readonly', actions: [{ id: 'x', tool: 'system_info' }] });
    expect((await e.run(read.id)).state).toBe('completed');
    const write = e.create({ goal: 'write', autonomy: 'readonly', actions: [{ id: 'x', tool: 'write_file' }] });
    expect((await e.run(write.id)).state).toBe('failed');
  });

  it('runs an explicit verification step before marking an action successful', async () => {
    const calls: string[] = [];
    const e = engine(calls);
    const row = e.create({ goal: 'verify', autonomy: 'safe', actions: [{ id: 'x', tool: 'write_file', verify: { tool: 'file_info', arguments: { path: '/tmp/x' } } }] });
    const result = await e.run(row.id);
    expect(result.state).toBe('completed');
    expect(calls.map(x => x.split(':')[0])).toEqual(['write_file', 'file_info']);
  });

  it('runs compensation rollback in reverse order after failure', async () => {
    const calls: string[] = [];
    const e = engine(calls, { fail: new Error('boom') });
    const row = e.create({ goal: 'rollback', autonomy: 'safe', actions: [
      { id: 'a', tool: 'first', rollback: { tool: 'undo_first' } },
      { id: 'b', tool: 'fail', dependsOn: ['a'] },
    ] });
    const result = await e.run(row.id);
    expect(result.state).toBe('failed');
    expect(calls.map(x => x.split(':')[0])).toEqual(['first', 'fail', 'undo_first']);
    expect(result.context.decisions).toContain('rollback started after task failure');
  });

  it('supports on_failure compensation branches', async () => {
    const calls: string[] = [];
    const e = engine(calls, { fail: new Error('boom') });
    const row = e.create({ goal: 'failure branch', autonomy: 'safe', actions: [
      { id: 'a', tool: 'fail' },
      { id: 'recover', tool: 'recover', dependsOn: ['a'], condition: 'on_failure' },
    ] });
    const result = await e.run(row.id);
    expect(result.state).toBe('failed');
    expect(calls.map(x => x.split(':')[0])).toEqual(['fail', 'recover']);
  });

  it('isolates persisted tasks by token', async () => {
    const e1 = engine();
    const row = e1.create({ goal: 'private', autonomy: 'safe', actions: [{ id: 'x', tool: 'system_info' }] });
    const e2 = new TaskEngine('different-token', async () => ({ content: [{ type: 'text', text: 'ok' }] }), { dataDirectory: root });
    expect(e1.get(row.id)?.id).toBe(row.id);
    expect(e2.get(row.id)).toBeUndefined();
  });

  it('can resume a durably stored queued task with a fresh engine instance', async () => {
    const e1 = engine();
    const row = e1.create({ goal: 'resume', autonomy: 'safe', actions: [{ id: 'x', tool: 'system_info' }] });
    const e2 = engine();
    const result = await e2.resume(row.id);
    expect(result.state).toBe('completed');
  });

  it('rejects invalid action references before persistence', () => {
    const e = engine();
    expect(() => e.create({ goal: 'bad ref', autonomy: 'safe', actions: [{ id: 'x', tool: 'system_info', dependsOn: ['missing'] }] })).toThrow(/unknown dependency/);
  });

  it('turns a tool-level error into a failed task and records the action error', async () => {
    const e = engine([], { broken: new Error('permission denied') });
    const row = e.create({ goal: 'error', autonomy: 'safe', actions: [{ id: 'x', tool: 'broken' }] });
    const result = await e.run(row.id);
    expect(result.state).toBe('failed');
    expect(result.actions[0].status).toBe('failed');
    expect(result.actions[0].error).toContain('permission denied');
  });

  it('enforces specialized agent profiles and autonomy ceilings', () => {
    const e = engine();
    expect(() => e.create({ goal: 'bad agent', autonomy: 'readonly', actions: [{ id: 'x', agent: 'explorer', tool: 'run_command' }] })).toThrow(/not permitted/);
    expect(() => e.create({ goal: 'bad autonomy', autonomy: 'autonomous', actions: [{ id: 'x', agent: 'tester', tool: 'system_info' }] })).toThrow(/cannot run/);
    expect(() => e.create({ goal: 'good agent', autonomy: 'readonly', actions: [{ id: 'x', agent: 'explorer', tool: 'system_info' }] })).not.toThrow();
  });

  it('supports dry-run without invoking an action', async () => {
    const calls: string[] = [];
    const e = engine(calls);
    const row = e.create({ goal: 'preview', autonomy: 'autonomous', dryRun: true, actions: [{ id: 'x', tool: 'run_command', arguments: { command: 'true' } }] });
    expect(row.state).toBe('completed');
    expect(calls).toHaveLength(0);
  });
});
