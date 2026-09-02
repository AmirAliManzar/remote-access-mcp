import { describe, expect, it } from 'vitest';
import { jobManager } from '../src/core/jobs.js';

describe('worker jobs', () => {
  it('runs a background command and records output', async () => {
    const j = jobManager.create('printf hello', 'test-token', undefined, 10_000, 1);
    const deadline = Date.now() + 10_000;
    let current = jobManager.get(j.id, 'test-token');
    while (current && !['succeeded','failed','cancelled','timed_out'].includes(current.status) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
      current = jobManager.get(j.id, 'test-token');
    }
    expect(current?.status).toBe('succeeded');
    expect(current?.output).toContain('hello');
  });
});
