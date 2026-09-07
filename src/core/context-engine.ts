import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './platform.js';

export type ContextMode = 'minimal' | 'balanced' | 'full';

export interface ContextEngineOptions {
  mode?: ContextMode;
  maxTextChars?: number;
  maxContextChars?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  maxMemoryEntries?: number;
  maxSnapshots?: number;
}

export interface ContextEngineStats {
  requests: number;
  transformed: number;
  cacheHits: number;
  cacheWrites: number;
  cacheEntries: number;
  memoryEntries: number;
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
}

interface CacheEntry {
  createdAt: number;
  expiresAt: number;
  result: unknown;
}

interface MemoryEntry {
  ts: number;
  tool: string;
  summary: string;
  fingerprint: string;
}

interface PersistedState {
  cache: Record<string, CacheEntry>;
  memory: MemoryEntry[];
  snapshots: Record<string, { ts: number; text: string }>;
}

const DEFAULTS = {
  maxTextChars: 32_000,
  cacheTtlMs: 10_000,
  maxCacheEntries: 128,
  maxMemoryEntries: 64,
};

/**
 * Project-local context engine. It deliberately stores state below RAMCP's
 * own dataDir and is keyed by the authenticated token fingerprint.
 *
 * The engine is conservative: it only compacts JSON/text representations and
 * only caches explicitly read-only tool names. Mutating tools are never
 * replayed from cache.
 */
const ENGINE_CACHE = new Map<string, ContextEngine>();

/** Reuse one engine per token inside a gateway process; persisted state covers restarts. */
export function contextEngineForToken(token: string): ContextEngine {
  const key = crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
  const existing = ENGINE_CACHE.get(key);
  if (existing) return existing;
  const engine = new ContextEngine(token);
  if (ENGINE_CACHE.size >= 256) ENGINE_CACHE.delete(ENGINE_CACHE.keys().next().value!);
  ENGINE_CACHE.set(key, engine);
  return engine;
}

export class ContextEngine {
  private readonly mode: ContextMode;
  private maxTextChars: number;
  private readonly maxContextChars: number;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly maxMemoryEntries: number;
  private readonly maxSnapshots: number;
  private readonly tokenKey: string;
  private readonly statePath: string;
  private state: PersistedState;
  private stats: ContextEngineStats = {
    requests: 0, transformed: 0, cacheHits: 0, cacheWrites: 0,
    cacheEntries: 0, memoryEntries: 0, inputBytes: 0, outputBytes: 0, savedBytes: 0,
  };

  constructor(token: string, options: ContextEngineOptions = {}) {
    this.mode = options.mode || parseMode(process.env.RAMCP_CONTEXT_MODE);
    this.maxTextChars = options.maxTextChars || numberEnv('RAMCP_CONTEXT_MAX_CHARS', DEFAULTS.maxTextChars);
    this.maxContextChars = options.maxContextChars || numberEnv('RAMCP_CONTEXT_BUDGET_CHARS', this.maxTextChars);
    this.cacheTtlMs = options.cacheTtlMs ?? numberEnv('RAMCP_CONTEXT_CACHE_TTL_MS', DEFAULTS.cacheTtlMs);
    this.maxCacheEntries = options.maxCacheEntries || numberEnv('RAMCP_CONTEXT_CACHE_ENTRIES', DEFAULTS.maxCacheEntries);
    this.maxMemoryEntries = options.maxMemoryEntries || DEFAULTS.maxMemoryEntries;
    this.maxSnapshots = options.maxSnapshots || 32;
    this.tokenKey = crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
    this.statePath = path.join(dataDir(), 'context-engine', `${this.tokenKey}.json`);
    this.state = this.load();
    this.refreshCounts();
  }

  getStats(): ContextEngineStats & { mode: ContextMode; maxTextChars: number; maxContextChars: number } {
    this.refreshCounts();
    return { ...this.stats, mode: this.mode, maxTextChars: this.maxTextChars, maxContextChars: this.maxContextChars };
  }

  /** Returns a cached result for a safe read-only tool, if still fresh. */
  getCached(tool: string, args: unknown): unknown | undefined {
    if (!isCacheableTool(tool) || this.mode === 'full') return undefined;
    const key = cacheKey(tool, args);
    const entry = this.state.cache[key];
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      delete this.state.cache[key];
      this.persist();
      return undefined;
    }
    this.stats.cacheHits += 1;
    return clone(entry.result);
  }

  /** Record a safe read result for short-lived request de-duplication. */
  putCached(tool: string, args: unknown, result: unknown): void {
    if (!isCacheableTool(tool) || this.mode === 'full') return;
    const now = Date.now();
    this.state.cache[cacheKey(tool, args)] = { createdAt: now, expiresAt: now + this.cacheTtlMs, result: clone(result) };
    this.trimCache();
    this.stats.cacheWrites += 1;
    this.persist();
  }

  /** Fit a result to a caller-defined context budget without changing error state. */
  fitBudget(result: any, maxChars = this.maxContextChars): any {
    const previous = this.maxTextChars;
    this.maxTextChars = Math.max(1, maxChars);
    try { return this.compactResult(result); } finally { (this as any).maxTextChars = previous; }
  }

  /** Compact a tool result without changing its success/error semantics. */
  compactResult(result: any): any {
    this.stats.requests += 1;
    if (!result || !Array.isArray(result.content)) return result;

    let changed = false;
    let inputBytes = 0;
    let outputBytes = 0;
    const content = result.content.map((item: any) => {
      if (!item || item.type !== 'text' || typeof item.text !== 'string') return item;
      const original = item.text;
      inputBytes += Buffer.byteLength(original);
      let text = original;

      if (this.mode !== 'full' && looksJson(text)) {
        try {
          const parsed = JSON.parse(text);
          text = JSON.stringify(compactJson(parsed, this.mode));
        } catch { /* plain text despite JSON-looking prefix */ }
      }

      if (this.mode === 'minimal' || this.mode === 'balanced') {
        text = dedupeLines(text);
      }
      if (this.mode === 'minimal') {
        text = collapseBlankLines(text);
      }
      if (text.length > this.maxTextChars) {
        const marker = `… [context-engine truncated; use a narrower query or full mode]`;
        const kept = Math.max(0, this.maxTextChars - marker.length - 1);
        text = `${text.slice(0, kept)}\n${marker}`;
      }

      outputBytes += Buffer.byteLength(text);
      if (text !== original) changed = true;
      return text === original ? item : { ...item, text };
    });

    this.stats.inputBytes += inputBytes;
    this.stats.outputBytes += outputBytes;
    this.stats.savedBytes += Math.max(0, inputBytes - outputBytes);
    if (changed) this.stats.transformed += 1;
    return changed ? { ...result, content } : result;
  }

  remember(tool: string, args: unknown, result: any): void {
    const summary = summarizeResult(result);
    this.state.memory.push({ ts: Date.now(), tool, summary, fingerprint: cacheKey(tool, args) });
    if (this.state.memory.length > this.maxMemoryEntries) this.state.memory.splice(0, this.state.memory.length - this.maxMemoryEntries);
    this.persist();
  }

  recentMemory(limit = 12): MemoryEntry[] {
    return this.state.memory.slice(-Math.max(1, Math.min(limit, this.maxMemoryEntries))).map(clone);
  }

  snapshot(text: string): string {
    const id = crypto.createHash('sha256').update(`${Date.now()}:${text}`).digest('hex').slice(0, 16);
    this.state.snapshots[id] = { ts: Date.now(), text };
    const entries = Object.entries(this.state.snapshots).sort((a, b) => a[1].ts - b[1].ts);
    while (entries.length > this.maxSnapshots) delete this.state.snapshots[entries.shift()![0]];
    this.persist();
    return id;
  }

  diffSnapshot(id: string, text: string): { found: boolean; changed: boolean; added: number; removed: number; diff: string } {
    const snapshot = this.state.snapshots[id];
    if (!snapshot) return { found: false, changed: false, added: 0, removed: 0, diff: '' };
    const before = snapshot.text.split('\n');
    const after = text.split('\n');
    const max = Math.max(before.length, after.length);
    const lines: string[] = [];
    let added = 0; let removed = 0;
    for (let i = 0; i < max; i += 1) {
      if (before[i] === after[i]) continue;
      if (before[i] !== undefined) { lines.push(`- ${before[i]}`); removed += 1; }
      if (after[i] !== undefined) { lines.push(`+ ${after[i]}`); added += 1; }
    }
    return { found: true, changed: added > 0 || removed > 0, added, removed, diff: lines.join('\n').slice(0, this.maxTextChars) };
  }

  clear(): void {
    this.state = { cache: {}, memory: [], snapshots: {} };
    this.persist();
    this.refreshCounts();
  }

  private load(): PersistedState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as PersistedState;
      return { cache: parsed.cache || {}, memory: Array.isArray(parsed.memory) ? parsed.memory : [], snapshots: parsed.snapshots || {} };
    } catch {
      return { cache: {}, memory: [], snapshots: {} };
    }
  }

  private persist(): void {
    const lockPath = `${this.statePath}.lock`;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
      let fd: number | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          fd = fs.openSync(lockPath, 'wx', 0o600);
          break;
        } catch {
          const wait = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(wait, 0, 0, 5);
        }
      }
      if (fd === undefined) return;
      try {
        const latest = this.load();
        latest.cache = { ...latest.cache, ...this.state.cache };
        latest.memory = [...latest.memory, ...this.state.memory.filter(item => !latest.memory.some(x => x.ts === item.ts && x.fingerprint === item.fingerprint))];
        latest.memory = latest.memory.slice(-this.maxMemoryEntries);
        latest.snapshots = { ...latest.snapshots, ...this.state.snapshots };
        const tmp = `${this.statePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(latest), { mode: 0o600 });
        fs.renameSync(tmp, this.statePath);
        this.state = latest;
      } finally {
        fs.closeSync(fd);
        try { fs.unlinkSync(lockPath); } catch { /* another cleanup path won */ }
      }
    } catch { /* context optimization must never break a tool request */ }
    this.refreshCounts();
  }

  private trimCache(): void {
    const entries = Object.entries(this.state.cache).sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (entries.length > this.maxCacheEntries) {
      const [key] = entries.shift()!;
      delete this.state.cache[key];
    }
  }

  private refreshCounts(): void {
    this.stats.cacheEntries = Object.keys(this.state.cache).length;
    this.stats.memoryEntries = this.state.memory.length;
  }
}

/** Safe reads whose results can be replayed for a very short TTL. */
export function isCacheableTool(tool: string): boolean {
  return new Set([
    'system_info', 'system_resource', 'system_diagnostics',
    'database_schema', 'sqlite_schema', 'package_list',
  ]).has(tool);
}

function cacheKey(tool: string, args: unknown): string {
  return crypto.createHash('sha256').update(`${tool}:${stableStringify(args)}`).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function compactJson(value: unknown, mode: ContextMode): unknown {
  if (Array.isArray(value)) {
    const max = mode === 'minimal' ? 100 : 250;
    if (value.length > max) return [...value.slice(0, max), `… [context-engine omitted ${value.length - max} items]`];
    return value.map(v => compactJson(v, mode));
  }
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) out[key] = compactJson(val, mode);
  return out;
}

function looksJson(text: string): boolean {
  const t = text.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

function dedupeLines(text: string): string {
  const lines = text.split('\n');
  if (lines.length < 4) return text;
  const out: string[] = [];
  let previous = '';
  let repeats = 0;
  for (const line of lines) {
    if (line === previous) {
      repeats += 1;
      continue;
    }
    if (repeats) out.push(`… [context-engine repeated previous line ${repeats}x]`);
    out.push(line);
    previous = line;
    repeats = 0;
  }
  if (repeats) out.push(`… [context-engine repeated previous line ${repeats}x]`);
  return out.join('\n');
}

function collapseBlankLines(text: string): string {
  return text.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim();
}

function summarizeResult(result: any): string {
  if (!result) return '';
  const text = Array.isArray(result.content) ? result.content.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('\n') : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function parseMode(value: string | undefined): ContextMode {
  return value === 'minimal' || value === 'full' ? value : 'balanced';
}

function numberEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
