import { describe, expect, it, afterEach } from 'vitest';
import { matchesConditions, createRule, tokenRules, deleteRule, setRuleEnabled, dispatchAutomationEvent, clearAutomationRulesForTests, type AutomationRule } from '../src/core/automation-engine.js';

describe('Phase 6 automation engine', () => {
  afterEach(() => clearAutomationRulesForTests());
  it('evaluates typed conditions', () => {
    const rule = { conditions: [
      { field: 'type', op: 'equals', value: 'tool.error' },
      { field: 'retries', op: 'gte', value: 3 },
      { field: 'message', op: 'contains', value: 'timeout' },
    ] } as AutomationRule;
    expect(matchesConditions(rule, { type: 'tool.error', data: { retries: 4, message: 'request timeout' }, ts: Date.now() })).toBe(true);
  });
  it('isolates persistent rules by token fingerprint', () => {
    const a = createRule({ name: 'a', tokenFingerprint: 'token-a', enabled: true, trigger: { type: 'interval', intervalSeconds: 60 }, conditions: [], actions: [{ tool: 'run_command', args: { command: 'true' } }] });
    const b = createRule({ name: 'b', tokenFingerprint: 'token-b', enabled: true, trigger: { type: 'interval', intervalSeconds: 60 }, conditions: [], actions: [{ tool: 'run_command', args: { command: 'true' } }] });
    expect(tokenRules('token-a').map(x => x.id)).toContain(a.id); expect(tokenRules('token-a').map(x => x.id)).not.toContain(b.id);
  });
  it('can pause and delete only owned rules', () => {
    const r = createRule({ name: 'x', tokenFingerprint: 'owner', enabled: true, trigger: { type: 'tool' }, conditions: [], actions: [{ tool: 'x', args: {} }] });
    expect(setRuleEnabled('other', r.id, false)).toBe(false); expect(setRuleEnabled('owner', r.id, false)).toBe(true);
    expect(deleteRule('other', r.id)).toBe(false); expect(deleteRule('owner', r.id)).toBe(true);
  });
  it('dispatches only matching rules owned by the event token', async () => {
    const a = createRule({ name: 'a', tokenFingerprint: 'token-a', enabled: true, trigger: { type: 'tool', tool: 'x' }, conditions: [{ field: 'type', op: 'equals', value: 'tool.error' }], actions: [{ tool: 'safe', args: {} }] });
    createRule({ name: 'b', tokenFingerprint: 'token-b', enabled: true, trigger: { type: 'tool', tool: 'x' }, conditions: [{ field: 'type', op: 'equals', value: 'tool.error' }], actions: [{ tool: 'safe', args: {} }] });
    const seen: string[] = [];
    await dispatchAutomationEvent({ type: 'tool.error', tool: 'x', tokenFingerprint: 'token-a', ts: Date.now() }, async (rule) => { seen.push(rule.id); });
    expect(seen).toEqual([a.id]);
  });
});

it('suppresses recursive automation-origin events', async () => {
  const r = createRule({ name: 'loop', tokenFingerprint: 'loop-owner', enabled: true, trigger: { type: 'tool', tool: 'safe' }, conditions: [], actions: [{ tool: 'safe', args: {} }] });
  let calls = 0;
  await dispatchAutomationEvent({ type: 'tool.success', tool: 'safe', tokenFingerprint: 'loop-owner', origin: 'automation', depth: 1, ts: Date.now() }, async () => { calls++; });
  expect(calls).toBe(0);
  expect(tokenRules('loop-owner').find(x => x.id === r.id)?.runs).toBe(0);
});

it('prevents duplicate concurrent execution in one process', async () => {
  const r = createRule({ name: 'once', tokenFingerprint: 'once-owner', enabled: true, trigger: { type: 'tool', tool: 'once' }, conditions: [], actions: [{ tool: 'safe', args: {} }] });
  let calls = 0;
  const execute = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 30)); };
  await Promise.all([
    dispatchAutomationEvent({ type: 'tool.success', tool: 'once', tokenFingerprint: 'once-owner', ts: Date.now() }, execute),
    dispatchAutomationEvent({ type: 'tool.success', tool: 'once', tokenFingerprint: 'once-owner', ts: Date.now() }, execute),
  ]);
  expect(calls).toBe(1);
  expect(tokenRules('once-owner').find(x => x.id === r.id)?.runs).toBe(1);
});
