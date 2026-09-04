import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ramcp-changes-home-'));
process.env.XDG_CONFIG_HOME = path.join(home, '.config');

const { captureChange, rollbackChangeSet } = await import('../src/tools/changes.js');

const token = { token: 'change-test-token', allowed_paths: [] as string[], denied_paths: [] as string[], shell_enabled: false };
const ctx: any = { token, readOnly: false, cfg: {}, persist() {}, audit() {} };

async function openChangeSet(): Promise<string> {
  const { randomBytes } = await import('node:crypto');
  const id = randomBytes(6).toString('hex');
  const store = path.join(process.env.XDG_CONFIG_HOME!, 'remote-access-mcp', 'change-sets.json');
  const now = new Date().toISOString();
  await fs.mkdir(path.dirname(store), { recursive: true });
  const rows = JSON.parse((await fs.readFile(store, 'utf8').catch(() => '[]')));
  const tokenId = crypto.createHash('sha256').update(token.token).digest('hex').slice(0, 16);
  rows.push({ id, tokenId, status: 'open', files: [], created: now, updated: now });
  await fs.writeFile(store, JSON.stringify(rows, null, 2));
  return id;
}

beforeEach(async () => {
  token.allowed_paths = [path.join(home, 'workspace')];
  token.denied_paths = [];
  await fs.rm(token.allowed_paths[0], { recursive: true, force: true });
  await fs.mkdir(token.allowed_paths[0], { recursive: true });
});
afterEach(async () => { token.denied_paths = []; });

describe('change set rollback', () => {
  it('restores modified and deleted files and removes files created after capture', async () => {
    const root = token.allowed_paths[0];
    const existing = path.join(root, 'existing.txt');
    const deleted = path.join(root, 'deleted.txt');
    const created = path.join(root, 'created.txt');
    await fs.writeFile(existing, 'before');
    await fs.writeFile(deleted, 'delete-me');
    const id = await openChangeSet();
    await captureChange(ctx, id, existing);
    await captureChange(ctx, id, deleted);
    await captureChange(ctx, id, created);
    await fs.writeFile(existing, 'after');
    await fs.rm(deleted);
    await fs.writeFile(created, 'new');

    const result = await rollbackChangeSet(ctx, id);
    expect(result.errors).toEqual([]);
    expect(await fs.readFile(existing, 'utf8')).toBe('before');
    expect(await fs.readFile(deleted, 'utf8')).toBe('delete-me');
    await expect(fs.access(created)).rejects.toThrow();
  });

  it('is resumable when policy blocks one path during rollback', async () => {
    const root = token.allowed_paths[0];
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    await fs.writeFile(first, 'one');
    await fs.writeFile(second, 'two');
    const id = await openChangeSet();
    await captureChange(ctx, id, first);
    await captureChange(ctx, id, second);
    await fs.writeFile(first, 'ONE');
    await fs.writeFile(second, 'TWO');
    token.denied_paths = [second];
    const partial = await rollbackChangeSet(ctx, id);
    expect(partial.errors.length).toBe(1);
    expect(await fs.readFile(first, 'utf8')).toBe('one');
    expect(await fs.readFile(second, 'utf8')).toBe('TWO');
    token.denied_paths = [];
    const resumed = await rollbackChangeSet(ctx, id);
    expect(resumed.errors).toEqual([]);
    expect(await fs.readFile(second, 'utf8')).toBe('two');
  });
});
