import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './platform.js';

export interface ProjectProfile {
  id: string;
  tokenId: string;
  root: string;
  name: string;
  stack?: string[];
  packageManager?: string;
  testCommand?: string;
  buildCommand?: string;
  lintCommand?: string;
  notes?: string;
  updatedAt: string;
}

function tokenId(token: string): string { return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16); }
function file(token: string): string { return path.join(dataDir(), 'project-profiles', `${tokenId(token)}.json`); }
function load(token: string): ProjectProfile[] { try { const v = JSON.parse(fs.readFileSync(file(token), 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } }
function save(token: string, rows: ProjectProfile[]): void {
  const f = file(token); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}-${crypto.randomUUID()}.tmp`; fs.writeFileSync(tmp, JSON.stringify(rows.slice(-100), null, 2), { mode: 0o600 }); fs.renameSync(tmp, f);
}

export function listProjectProfiles(token: string): ProjectProfile[] { return load(token); }
export function getProjectProfile(token: string, root: string): ProjectProfile | undefined { return load(token).find(p => path.resolve(p.root) === path.resolve(root)); }
export function setProjectProfile(token: string, input: Omit<ProjectProfile, 'id'|'tokenId'|'updatedAt'>): ProjectProfile {
  const rows = load(token); const existing = rows.find(p => path.resolve(p.root) === path.resolve(input.root));
  const row: ProjectProfile = { ...input, id: existing?.id || crypto.randomUUID(), tokenId: tokenId(token), updatedAt: new Date().toISOString() };
  const next = rows.filter(p => p.id !== existing?.id); next.push(row); save(token, next); return row;
}
