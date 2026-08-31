import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Tamper-evident audit log — zero native dependencies.
 *
 * Append-only JSONL file with a hash chain: every line's hash covers the
 * line before it, so deleting or editing any line breaks every hash after
 * it and `verify()` reports the first bad line.
 *
 * (The previous implementation used better-sqlite3; its native binding
 * crashes Node with SIGABRT when used inside the MCP SDK's stateless
 * request loop — see Statement::~Statement assertion in teardown.
 * A plain append + fsync is also faster for a write-once log and has no
 * native code in the dependency tree.)
 */
export interface AuditEntry {
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
  private filePath: string;
  private lastHash = '';

  constructor(dbPath: string) {
    // Ignore a stale .db from earlier versions; JSONL is the live format.
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.filePath = dbPath.replace(/\.db$/, '') + '.jsonl';
    this.lastHash = this.readLastHash();
  }

  private readLastHash(): string {
    try {
      const content = fs.readFileSync(this.filePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      if (!lines.length) return '';
      const last = JSON.parse(lines[lines.length - 1]) as AuditEntry;
      return last.hash || '';
    } catch {
      return '';
    }
  }

  /** Fingerprint a token so the raw secret never lands in the audit file. */
  static fingerprint(token: string): string {
    return createHash('sha256').update(token).digest('hex').slice(0, 16);
  }

  record(entry: Omit<AuditEntry, 'prev_hash' | 'hash'>): void {
    const prev = this.lastHash;
    const material = [entry.ts, entry.token_fingerprint, entry.tool, entry.args_json, entry.ok, entry.is_error, entry.duration_ms, prev].join('|');
    const hash = createHash('sha256').update(material).digest('hex');
    this.lastHash = hash;
    const full: AuditEntry = { ...entry, prev_hash: prev, hash };
    const line = JSON.stringify(full) + '\n';
    const fd = fs.openSync(this.filePath, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Verify the hash chain. Returns the 1-based line number of the first tampered row, or null. */
  verify(): number | null {
    let content: string;
    try {
      content = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return null; // no log yet = intact
    }
    let prev = '';
    let lineNo = 0;
    for (const line of content.split('\n')) {
      if (!line) continue;
      lineNo++;
      let r: AuditEntry;
      try { r = JSON.parse(line); } catch { return lineNo; } // corrupted line itself
      const material = [r.ts, r.token_fingerprint, r.tool, r.args_json, r.ok, r.is_error, r.duration_ms, r.prev_hash].join('|');
      const expected = createHash('sha256').update(material).digest('hex');
      if (r.prev_hash !== prev || r.hash !== expected) return lineNo;
      prev = r.hash;
    }
    return null;
  }

  query(opts: { tool?: string; since?: number; limit?: number; fingerprint?: string }): AuditEntry[] {
    let content: string;
    try {
      content = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const all: AuditEntry[] = [];
    for (const line of content.split('\n')) {
      if (!line) continue;
      try { all.push(JSON.parse(line)); } catch { /* skip corrupt */ }
    }
    let rows = all.reverse();
    if (opts.tool) rows = rows.filter(r => r.tool === opts.tool);
    if (opts.since) rows = rows.filter(r => r.ts >= opts.since!);
    if (opts.fingerprint) rows = rows.filter(r => r.token_fingerprint === opts.fingerprint);
    return rows.slice(0, Math.min(opts.limit || 100, 1000));
  }

  close(): void { /* no persistent handles — nothing to close */ }
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
