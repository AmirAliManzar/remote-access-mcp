import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from '../src/core/platform.js';
import { requestApproval, getApproval, decideApproval } from '../src/core/approvals.js';

beforeEach(() => fs.rmSync(path.join(dataDir(), 'approvals.json'), { force: true }));

describe('durable approvals', () => {
  it('persists pending and decided state to disk', () => {
    const a = requestApproval('requester', 'echo hello', '/tmp');
    expect(getApproval(a.id, 'requester')?.status).toBe('pending');
    expect(fs.existsSync(path.join(dataDir(), 'approvals.json'))).toBe(true);

    const decided = decideApproval(a.id, undefined, true, 'operator');
    expect(decided?.status).toBe('approved');
    expect(decided?.decidedBy).toBe('operator');
    expect(decided?.decided).toBeTruthy();
    expect(getApproval(a.id)?.status).toBe('approved');
  });

  it('survives module state loss because the persisted record is authoritative', () => {
    const a = requestApproval('requester', 'echo restart');
    expect(getApproval(a.id)?.status).toBe('pending');
    const file = path.join(dataDir(), 'approvals.json');
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ id: string; status: string }>;
    expect(persisted.find(r => r.id === a.id)?.status).toBe('pending');
    expect(decideApproval(a.id, undefined, false, 'operator')?.status).toBe('rejected');
    const persistedAfter = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ id: string; status: string }>;
    expect(persistedAfter.find(r => r.id === a.id)?.status).toBe('rejected');
  });

  it('binds approval to the exact command/cwd and allows only one use', async () => {
    const { consumeApproval } = await import('../src/core/approvals.js');
    const a = requestApproval('requester', 'echo once', '/tmp');
    expect(decideApproval(a.id, undefined, true, 'operator')?.status).toBe('approved');
    expect(consumeApproval(a.id, 'requester', 'echo other', '/tmp')).toBeUndefined();
    expect(consumeApproval(a.id, 'requester', 'echo once', '/other')).toBeUndefined();
    expect(consumeApproval(a.id, 'requester', 'echo once', '/tmp')?.status).toBe('consumed');
    expect(consumeApproval(a.id, 'requester', 'echo once', '/tmp')).toBeUndefined();
    expect(getApproval(a.id)?.status).toBe('consumed');
  });



  it('creates a private store', () => {
    const a = requestApproval('requester', 'echo permissions');
    expect(a.id).toHaveLength(12);
    const mode = fs.statSync(path.join(dataDir(), 'approvals.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
