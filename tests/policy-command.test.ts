import { describe, expect, it } from 'vitest';
import { assertCommandPolicy } from '../src/core/policy.js';

describe('command allowlist hardening', () => {
  const policy = { command_allowlist: ['git'] };
  it('allows the listed executable with ordinary arguments', () => {
    expect(() => assertCommandPolicy(policy, 'git status')).not.toThrow();
    expect(() => assertCommandPolicy(policy, '/usr/bin/git status')).not.toThrow();
  });
  it.each([
    'git && id', 'git; id', 'git | id', 'git || id', 'git & id',
    'git $(id)', 'git `id`', 'git > /tmp/out', 'git < /tmp/in',
  ])('rejects shell injection: %s', command => {
    expect(() => assertCommandPolicy(policy, command)).toThrow();
  });
  it('rejects shell injection through a newline', () => {
    expect(() => assertCommandPolicy(policy, 'git\nid')).toThrow();
  });
  it('rejects shell injection through a carriage return', () => {
    expect(() => assertCommandPolicy(policy, 'git\rid')).toThrow();
  });
  it('allows an exact command containing shell syntax when explicitly allowlisted', () => {
    expect(() => assertCommandPolicy({ command_allowlist: ['git && id'] }, 'git && id')).not.toThrow();
  });
  it('rejects an empty command when a policy is evaluated', () => {
    expect(() => assertCommandPolicy({ command_allowlist: ['git'] }, '   ')).toThrow();
  });
});
