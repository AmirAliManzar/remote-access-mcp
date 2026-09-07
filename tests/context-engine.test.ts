import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { ContextEngine, isCacheableTool } from '../src/core/context-engine.js';
import { dataDir } from '../src/core/platform.js';

describe('context engine', () => {
  beforeEach(() => {
    fs.rmSync(path.join(dataDir(), 'context-engine'), { recursive: true, force: true });
  });

  it('compacts JSON without changing semantics', () => {
    const engine = new ContextEngine('token-a', { mode: 'balanced', maxTextChars: 10_000 });
    const result = engine.compactResult({ content: [{ type: 'text', text: JSON.stringify({ a: [1, 2], b: { c: true } }, null, 2) }] });
    expect(JSON.parse(result.content[0].text)).toEqual({ a: [1, 2], b: { c: true } });
    expect(engine.getStats().savedBytes).toBeGreaterThan(0);
  });

  it('truncates oversized text with an actionable marker', () => {
    const engine = new ContextEngine('token-b', { mode: 'balanced', maxTextChars: 100 });
    const result = engine.compactResult({ content: [{ type: 'text', text: 'x'.repeat(1000) }] });
    expect(result.content[0].text.length).toBeLessThanOrEqual(100);
    expect(result.content[0].text).toContain('context-engine truncated');
  });

  it('deduplicates consecutive repeated lines in minimal mode', () => {
    const engine = new ContextEngine('token-c', { mode: 'minimal', maxTextChars: 10_000 });
    const result = engine.compactResult({ content: [{ type: 'text', text: 'a\na\na\na\nb' }] });
    expect(result.content[0].text).toContain('repeated previous line 3x');
  });

  it('caches only safe reads and persists them per token', () => {
    const a = new ContextEngine('token-d', { mode: 'balanced', cacheTtlMs: 60_000 });
    const value = { content: [{ type: 'text', text: 'hello' }] };
    expect(isCacheableTool('system_info')).toBe(true);
    expect(isCacheableTool('shell_exec')).toBe(false);
    a.putCached('system_info', { x: 1 }, value);
    expect(a.getCached('system_info', { x: 1 })).toEqual(value);

    const b = new ContextEngine('token-e', { mode: 'balanced' });
    expect(b.getCached('system_info', { x: 1 })).toBeUndefined();
    const c = new ContextEngine('token-d', { mode: 'balanced' });
    expect(c.getCached('system_info', { x: 1 })).toEqual(value);
  });

  it('never caches mutating tools', () => {
    const engine = new ContextEngine('token-f');
    const value = { content: [{ type: 'text', text: 'changed' }] };
    engine.putCached('filesystem_write', { path: '/tmp/x' }, value);
    expect(engine.getCached('filesystem_write', { path: '/tmp/x' })).toBeUndefined();
  });

  it('creates and diffs token-local snapshots', () => {
    const engine = new ContextEngine('token-snapshot');
    const id = engine.snapshot('a\nb');
    expect(engine.diffSnapshot(id, 'a\nc')).toEqual({ found: true, changed: true, added: 1, removed: 1, diff: '- b\n+ c' });
    expect(engine.diffSnapshot('missing', 'x').found).toBe(false);
  });

  it('keeps recent task memory isolated by token', () => {
    const a = new ContextEngine('token-g');
    a.remember('system_info', {}, { content: [{ type: 'text', text: 'alpha' }] });
    expect(a.recentMemory()[0].summary).toBe('alpha');
    const b = new ContextEngine('token-h');
    expect(b.recentMemory()).toEqual([]);
  });
});
