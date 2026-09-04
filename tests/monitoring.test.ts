import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from '../src/core/platform.js';
import { AuditLog } from '../src/core/audit.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-monitoring-'));
process.env.HOME = home;
delete process.env.XDG_CONFIG_HOME;

beforeEach(() => fs.rmSync(dataDir(), { recursive: true, force: true }));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('persistent health watcher storage', () => {
  it('uses a private atomic JSON store and survives module/process restart', async () => {
    fs.mkdirSync(dataDir(), { recursive: true });
    const file = path.join(dataDir(), 'health-watches.json');
    const row = { id: 'watch123456', tokenFingerprint: AuditLog.fingerprint('token-a'), intervalSeconds: 60, cpuPercent: 90, created: new Date().toISOString(), ownerPid: process.pid };
    fs.writeFileSync(file, JSON.stringify([row]), { mode: 0o600 });
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const script = `import fs from 'node:fs'; const p=process.env.FILE; const r=JSON.parse(fs.readFileSync(p,'utf8')); console.log(JSON.stringify(r[0]));`;
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, FILE: file } });
    expect(JSON.parse(stdout)).toMatchObject({ id: row.id, tokenFingerprint: row.tokenFingerprint, intervalSeconds: 60 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
