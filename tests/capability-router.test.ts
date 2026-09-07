import { describe, expect, it } from 'vitest';
import { authorizedCapabilities, isToolAuthorized } from '../src/core/capability-router.js';

describe('capability router', () => {
  it('filters capabilities by category scope', () => {
    const result = authorizedCapabilities(['filesystem']);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(x => x.category === 'filesystem')).toBe(true);
  });

  it('supports explicit tool scopes', () => {
    expect(isToolAuthorized('read_file', ['read_file'])).toBe(true);
    expect(isToolAuthorized('write_file', ['read_file'])).toBe(false);
  });

  it('keeps dynamically discovered integrations behind the integrations scope', () => {
    expect(isToolAuthorized('context7_query-docs', ['integrations'])).toBe(true);
    expect(isToolAuthorized('codebase_memory_search', ['integrations'])).toBe(true);
    expect(isToolAuthorized('context7_query-docs', ['filesystem'])).toBe(false);
  });
});
