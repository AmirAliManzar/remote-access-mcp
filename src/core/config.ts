import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export interface RamcpConfig {
  token: string;
  host: string;
  port: number;
  public_host: string;
  mcp_path: string;
  shell_enabled: boolean;
  allowed_paths: string[];
  denied_paths: string[];
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'remote-access-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function configDir(): string {
  return CONFIG_DIR;
}

export function configPath(): string {
  return CONFIG_FILE;
}

function resolveEnvFile(): string {
  // Back-compat: Dana-style .env next to cwd — only read explicitly, never write.
  const legacy = path.join(process.cwd(), '.env');
  if (fs.existsSync(legacy)) return legacy;
  return '';
}

export function loadConfig(): RamcpConfig {
  let cfg: Partial<RamcpConfig> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
  // Environment overrides (RAMCP_* / legacy DANA_* for parity with the old gateway)
  const env = process.env;
  const envToken = env.RAMCP_TOKEN || env.DANA_AUTH_TOKEN;
  const envHost = env.RAMCP_HOST || env.DANA_HOST;
  const envPort = env.RAMCP_PORT || env.DANA_PORT;
  const envPublic = env.RAMCP_PUBLIC_HOST || env.DANA_PUBLIC_HOST;
  const envShell = env.RAMCP_SHELL;
  const envAllow = env.RAMCP_ALLOWED_PATHS; // colon-separated
  const envDeny = env.RAMCP_DENIED_PATHS;   // colon-separated

  const resolved: RamcpConfig = {
    token: envToken || cfg.token || '',
    host: envHost || cfg.host || '127.0.0.1',
    port: envPort ? parseInt(envPort, 10) : (cfg.port || 8765),
    public_host: envPublic || cfg.public_host || '',
    mcp_path: cfg.mcp_path || '/mcp',
    shell_enabled: envShell !== undefined ? envShell === '1' || envShell === 'true' : (cfg.shell_enabled ?? false),
    allowed_paths: envAllow ? envAllow.split(':').filter(Boolean) : (cfg.allowed_paths || []),
    denied_paths: envDeny ? envDeny.split(':').filter(Boolean) : (cfg.denied_paths || []),
  };
  return resolved;
}

export function saveConfig(cfg: RamcpConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

export function generateToken(): string {
  return crypto.randomBytes(36).toString('base64url');
}

export function requireToken(cfg: RamcpConfig): string {
  if (!cfg.token) {
    console.error('No token configured. Run `ramcp init` first.');
    process.exit(1);
  }
  return cfg.token;
}
