import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { dataDir, legacyDataDir } from './platform.js';

// ---------------------------------------------------------------------------
// v2 config schema — multi-token, per-token policy/scope/expiry/rate
// ---------------------------------------------------------------------------

export interface TokenRecord {
  id: string;             // short uuid, used in CLI
  name: string;           // human label, e.g. "chatgpt-main"
  token: string;          // the secret
  created: string;        // ISO
  expires?: string;       // ISO — undefined = never
  scopes: string[];       // tool groups the token may use; empty = all
  read_only?: boolean;    // refuse mutating tools for this token
  max_requests_per_minute?: number; // per-token rate limit
  shell_enabled: boolean;
  allowed_paths: string[];
  denied_paths: string[];
}

export interface RamcpConfig {
  /** @deprecated v1 field — kept only for auto-migration */
  token?: string;
  host: string;
  port: number;
  public_host: string;
  mcp_path: string;
  /** Additional endpoint paths served alongside mcp_path (e.g. legacy /mcp). */
  mcp_path_aliases?: string[];
  /** Tunnel settings for laptops/desktops with no public IP. */
  tunnel?: { provider: 'cloudflare'; auto_start: boolean };
  /** Optional outbound webhooks fired on audit events (v3). */
  webhooks?: { url: string; events: string[]; enabled: boolean }[];
  log_level: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  audit: { enabled: boolean; db_path: string };
  read_only: boolean;             // global kill-switch for mutating tools
  tokens: TokenRecord[];
  /** @deprecated v1 fields — migrated into tokens[0] */
  shell_enabled?: boolean;
  allowed_paths?: string[];
  denied_paths?: string[];
}

// Config lives in the OS-appropriate per-user dir (AppData on Windows,
// Library/Application Support on macOS, XDG config on Linux).
const CONFIG_DIR = dataDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LEGACY_FILE = path.join(legacyDataDir(), 'config.json');

export function configDir(): string { return CONFIG_DIR; }
export function configPath(): string { return CONFIG_FILE; }
export function defaultAuditPath(): string { return path.join(CONFIG_DIR, 'audit.jsonl'); }

// ---------------------------------------------------------------------------
// Migration: v1 flat config → v2 token record
// ---------------------------------------------------------------------------
function migrateV1(raw: any): RamcpConfig {
  const v1token = raw.token || '';
  const rec: TokenRecord = {
    id: crypto.randomUUID(),
    name: 'default',
    token: v1token || crypto.randomBytes(36).toString('base64url'),
    created: new Date().toISOString(),
    scopes: [],
    shell_enabled: raw.shell_enabled ?? false,
    allowed_paths: raw.allowed_paths || [],
    denied_paths: raw.denied_paths || [],
  };
  return {
    host: raw.host || '127.0.0.1',
    port: raw.port || 8765,
    public_host: raw.public_host || '',
    mcp_path: raw.mcp_path || '/mcp',
    log_level: raw.log_level || 'info',
    audit: raw.audit || { enabled: true, db_path: defaultAuditPath() },
    read_only: raw.read_only ?? false,
    tokens: [rec],
  };
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------
export function loadConfig(): RamcpConfig {
  let raw: any = {};
  if (fs.existsSync(CONFIG_FILE)) {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } else if (fs.existsSync(LEGACY_FILE)) {
    // v2.x on Linux/macOS stored config in ~/.config; adopt it once and
    // carry the audit log along, so upgrading never loses tokens.
    raw = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    for (const f of ['audit.jsonl', 'schedule.json', 'plans.json', 'snapshots.json']) {
      const from = path.join(legacyDataDir(), f);
      const to = path.join(CONFIG_DIR, f);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        try { fs.copyFileSync(from, to); } catch { /* best effort */ }
      }
    }
    if (typeof raw.audit?.db_path === 'string') {
      raw.audit.db_path = path.join(CONFIG_DIR, path.basename(raw.audit.db_path));
    }
    saveConfig(raw);
  }
  // v1 shape? (flat token / no tokens array)
  if (!Array.isArray(raw.tokens)) {
    const migrated = migrateV1(raw);
    saveConfig(migrated); // persist immediately so we never re-migrate
    return migrated;
  }
  // default empty webhooks so callers never null-check
  if (!Array.isArray(raw.webhooks)) raw.webhooks = [];

  // v2.0→v2.0.2 audit path migration (.db → .jsonl, format switched off better-sqlite3)
  if (typeof raw.audit?.db_path === 'string' && raw.audit.db_path.endsWith('.db')) {
    raw.audit.db_path = raw.audit.db_path.replace(/\.db$/, '.jsonl');
    saveConfig(raw);
  }
  // v2.1.2→v2.1.3: when the primary path moved off /mcp, keep /mcp alive as a
  // legacy alias so already-registered connectors (Grok, older ChatGPT entries)
  // keep working instead of silently 404ing.
  if (typeof raw.mcp_path === 'string' && raw.mcp_path !== '/mcp') {
    const aliases = new Set(raw.mcp_path_aliases || []);
    aliases.add('/mcp');
    const list = [...aliases].filter(a => a !== raw.mcp_path);
    if (list.length !== (raw.mcp_path_aliases || []).length) {
      raw.mcp_path_aliases = list;
      saveConfig(raw);
    }
  }
  return raw as RamcpConfig;
}

export function saveConfig(cfg: RamcpConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Env overrides (RAMCP_* + legacy DANA_* back-compat)
// ---------------------------------------------------------------------------
function applyEnv(cfg: RamcpConfig): RamcpConfig {
  const env = process.env;
  const envToken = env.RAMCP_TOKEN || env.DANA_AUTH_TOKEN;
  const envHost = env.RAMCP_HOST || env.DANA_HOST;
  const envPort = env.RAMCP_PORT || env.DANA_PORT;
  const envPublic = env.RAMCP_PUBLIC_HOST || env.DANA_PUBLIC_HOST;
  const envShell = env.RAMCP_SHELL;
  const envAllow = env.RAMCP_ALLOWED_PATHS;
  const envDeny = env.RAMCP_DENIED_PATHS;

  const out = { ...cfg };
  if (envHost) out.host = envHost;
  if (envPort) out.port = parseInt(envPort, 10);
  if (envPublic) out.public_host = envPublic;
  if (envShell !== undefined) {
    const flag = envShell === '1' || envShell === 'true';
    out.tokens = out.tokens.map(t => ({ ...t, shell_enabled: flag }));
  }
  if (envAllow) {
    const paths = envAllow.split(':').filter(Boolean);
    out.tokens = out.tokens.map(t => ({ ...t, allowed_paths: paths }));
  }
  if (envDeny) {
    const paths = envDeny.split(':').filter(Boolean);
    out.tokens = out.tokens.map(t => ({ ...t, denied_paths: paths }));
  }
  // Single-token env mode: pin the default token (tests + minimal deployments)
  if (envToken) {
    out.tokens = out.tokens.map(t => t.name === 'default' ? { ...t, token: envToken } : t);
  }
  return out;
}

/** Load + apply env overrides. The canonical entry point. */
export function loadLiveConfig(): RamcpConfig {
  return applyEnv(loadConfig());
}

export function generateToken(): string {
  return crypto.randomBytes(36).toString('base64url');
}

export function newTokenRecord(partial: Partial<TokenRecord> & { name: string }): TokenRecord {
  return {
    id: crypto.randomUUID().slice(0, 8),
    name: partial.name,
    token: partial.token || generateToken(),
    created: new Date().toISOString(),
    expires: partial.expires,
    scopes: partial.scopes || [],
    read_only: partial.read_only ?? false,
    max_requests_per_minute: partial.max_requests_per_minute,
    shell_enabled: partial.shell_enabled ?? false,
    allowed_paths: partial.allowed_paths || [],
    denied_paths: partial.denied_paths || [],
  };
}

/** Resolve a presented secret to its token record (or null if invalid/expired). */
export function resolveToken(cfg: RamcpConfig, presented: string): TokenRecord | null {
  for (const t of cfg.tokens) {
    if (t.token === presented) {
      if (t.expires && new Date(t.expires).getTime() < Date.now()) return null;
      return t;
    }
  }
  return null;
}

/** The default (first) token — used by `ramcp url` and v1-era commands. */
export function primaryToken(cfg: RamcpConfig): TokenRecord {
  return cfg.tokens[0];
}

export function requireToken(cfg: RamcpConfig): TokenRecord {
  if (!cfg.tokens.length) {
    console.error('No tokens configured. Run `ramcp init` first.');
    process.exit(1);
  }
  return primaryToken(cfg);
}
