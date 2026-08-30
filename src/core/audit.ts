import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Tamper-evident audit log.
 *
 * Every tool invocation is recorded: token fingerprint, tool, arguments
 * (redacted), exit status, duration. A hash chain links entries so that
 * deleting or editing rows is detectable via `verify()`.
 */
export interface AuditEntry {
  id?: number;
  ts: number;
  token_fingerprint: string;
  tool: string;
  args_json: string;
  ok: number;
  is_error: number;
  duration_ms: number;
  prev_hash: string;
  hash: string;
}

export class AuditLog {
  private db: Database.Database;
  private lastHash = '';

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
    const row = this.db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined;
    this.lastHash = row?.hash || '';
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        token_fingerprint TEXT NOT NULL,
        tool TEXT NOT NULL,
        args_json TEXT NOT NULL,
        ok INTEGER NOT NULL,
        is_error INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
      CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit(tool);
    `);
  }

  /** Fingerprint a token so the raw secret never lands in the audit DB. */
  static fingerprint(token: string): string {
    return createHash('sha256').update(token).digest('hex').slice(0, 16);
  }

  record(entry: Omit<AuditEntry, 'id' | 'prev_hash' | 'hash'>): void {
    const prev = this.lastHash;
    const material = [entry.ts, entry.token_fingerprint, entry.tool, entry.args_json, entry.ok, entry.is_error, entry.duration_ms, prev].join('|');
    const hash = createHash('sha256').update(material).digest('hex');
    this.lastHash = hash;
    this.db.prepare(
      'INSERT INTO audit (ts, token_fingerprint, tool, args_json, ok, is_error, duration_ms, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(entry.ts, entry.token_fingerprint, entry.tool, entry.args_json, entry.ok, entry.is_error, entry.duration_ms, prev, hash);
  }

  /** Verify the hash chain. Returns the id of the first tampered row, or null. */
  verify(): number | null {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY id ASC').all() as AuditEntry[];
    let prev = '';
    for (const r of rows) {
      const material = [r.ts, r.token_fingerprint, r.tool, r.args_json, r.ok, r.is_error, r.duration_ms, r.prev_hash].join('|');
      const expected = createHash('sha256').update(material).digest('hex');
      if (r.prev_hash !== prev || r.hash !== expected) return r.id!;
      prev = r.hash;
    }
    return null;
  }

  query(opts: { tool?: string; since?: number; limit?: number; fingerprint?: string }): AuditEntry[] {
    const conds: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.tool) { conds.push('tool = @tool'); params.tool = opts.tool; }
    if (opts.since) { conds.push('ts >= @since'); params.since = opts.since; }
    if (opts.fingerprint) { conds.push('token_fingerprint = @fp'); params.fp = opts.fingerprint; }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    return this.db.prepare(`SELECT * FROM audit ${where} ORDER BY id DESC LIMIT @limit`).all({ ...params, limit: Math.min(opts.limit || 100, 1000) }) as AuditEntry[];
  }

  close(): void {
    this.db.close();
  }
}

/** Redact values that look like secrets before they reach the audit log. */
export function redactArgs(args: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (/pass|secret|token|key|auth/i.test(k)) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'string' && v.length > 300) {
      out[k] = v.slice(0, 300) + '…';
    } else {
      out[k] = v;
    }
  }
  return JSON.stringify(out);
}
