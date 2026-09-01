import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, saveConfig, generateToken, newTokenRecord,
  configPath, configDir, primaryToken,
  type RamcpConfig, type TokenRecord,
} from '../core/config.js';
import { resolveReal, TOOL_SCOPES } from '../core/policy.js';
import { AuditLog } from '../core/audit.js';
import { webhookStats } from '../core/webhooks.js';
import {
  platform, isWindows, isMac, isLinux, hasSystemd, which, platformLabel,
  readRuntimeState,
} from '../core/platform.js';
import { ensureCloudflared, startQuickTunnel, resolveCloudflared } from '../core/tunnel.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------
const HELP = `${PKG.name} v${PKG.version} — turn any machine into an AI-agent-accessible endpoint
Runs on Linux, macOS, and Windows.

Usage:
  ramcp <command> [options]

Getting started:
  init [--paths a,b]            Create config + first token
  start [--tunnel]              Run the gateway (--tunnel = public https URL)
  tunnel                        Start gateway + public URL, print connector link
  url [token]                   Print the connector URL for a chatbot
  doctor                        Diagnose everything in one pass
  status                        Config + service summary
  upgrade [--dry-run]           Self-update from npm
  version

Paths the AI may touch (per token):
  policy [--token N]                    Show policy
  policy allow <path...> [--token N]    Allow one or more directories
  policy deny <path...>  [--token N]    Deny directories
  policy shell on|off    [--token N]    Toggle shell execution
  policy scopes <groups> [--token N]    Limit to tool groups (or 'all')
  policy readonly on|off                Global read-only kill-switch

Tokens:
  token list [--json]
  token add --name N [--paths a,b] [--shell] [--scopes g,g]
            [--read-only] [--rpm N] [--expires YYYY-MM-DD]
  token show [N] [--full] | token rotate [N] | token revoke N

Audit:
  audit [--tool T] [--since ISO] [--limit N] [--json]
  audit chain                   Verify tamper-evident hash chain

Service (autostart):
  service install [--domain D]  systemd (Linux) / launchd (macOS) / schtasks (Windows)
  service uninstall | logs [-f] | status

Other:
  schedule list [--json]
  scopes                        List available tool groups

Webhooks:
  webhook add --url https://… [--events tool.error,tool.success]
  webhook list | off URL | on URL | remove URL

Config:
  config show | export [--out FILE] | import FILE [--merge]

Options:
  -h, --help                    Show this help
  --json                        Machine-readable output where supported
`;

// ---------------------------------------------------------------------------
// arg parser
// ---------------------------------------------------------------------------
interface Args {
  command: string;
  sub: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  const [command = '', ...rest] = argv;
  const sub: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  // Flags that always take a value (so `--paths /a /b` still works positionally)
  const valueFlags = new Set(['name', 'paths', 'deny', 'scopes', 'rpm', 'expires', 'token', 'host', 'port', 'domain', 'tool', 'since', 'limit', 'tools', 'url', 'events', 'out', 'note']);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq > 0) { values.set(key.slice(0, eq), key.slice(eq + 1)); continue; }
      const next = rest[i + 1];
      if (valueFlags.has(key) && next !== undefined && !next.startsWith('--')) {
        values.set(key, next);
        i++;
      } else {
        flags.add(key);
      }
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      for (const c of a.slice(1)) flags.add(c);
    } else {
      sub.push(a);
    }
  }
  return { command, sub, flags, values };
}

const jsonOut = (args: Args) => args.flags.has('json');
const splitList = (s?: string) => (s || '').split(',').map(x => x.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function findToken(cfg: RamcpConfig, idOrName?: string): TokenRecord {
  if (!idOrName) return primaryToken(cfg);
  const t = cfg.tokens.find(t => t.id === idOrName || t.name === idOrName);
  if (!t) {
    console.error(`Token "${idOrName}" not found. Try \`ramcp token list\`.`);
    process.exit(1);
  }
  return t;
}

const mask = (t: string) => t.slice(0, 6) + '…' + t.slice(-4);

function run(cmd: string, args: string[]): string {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
}

function banner(): string {
  return `
  ___                        _____
 | _ \\__ _ __ _ ___ _ _   |_   _|__ _ _ _ __ _ ___
 |   / _\` / _\` / -_) '_|    | |/ - \\ '_| '_/ _\` / -_)
 |_|_\\__,_\\__, \\___|_|      |_|\\___/_| |_| \\__,_\\___|
          |___/         ${PKG.name} v${PKG.version}
`;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
function cmdInit(args: Args): void {
  const existing = fs.existsSync(configPath());
  const cfg = existing ? loadConfig() : null;
  const extraPaths = [...splitList(args.values.get('paths')), ...args.sub].map(resolveReal);

  if (cfg && cfg.tokens.length) {
    if (extraPaths.length) {
      const t = primaryToken(cfg);
      for (const p of extraPaths) if (!t.allowed_paths.includes(p)) t.allowed_paths.push(p);
      saveConfig(cfg);
      console.log(`Added ${extraPaths.length} path(s) to token "${t.name}".`);
      return;
    }
    console.log(`Config already exists with ${cfg.tokens.length} token(s) — nothing to do.`);
    console.log('Add paths:   ramcp policy allow <dir>');
    console.log('Add tokens:  ramcp token add --name <name>');
    return;
  }

  const fresh: RamcpConfig = cfg || {
    host: '127.0.0.1',
    port: 8765,
    public_host: '',
    mcp_path: '/mcp',
    log_level: 'info',
    audit: { enabled: true, db_path: path.join(configDir(), 'audit.jsonl') },
    read_only: false,
    tokens: [],
  };
  const rec = newTokenRecord({ name: 'default', allowed_paths: extraPaths });
  fresh.tokens.push(rec);
  saveConfig(fresh);

  console.log(banner());
  console.log(`platform:  ${platformLabel()}`);
  console.log(`config:    ${configPath()}`);
  console.log(`token:     ${mask(rec.token)}  (full: ramcp token show --full)`);
  console.log(`paths:     ${extraPaths.length ? extraPaths.join(', ') : '(none — add with `ramcp policy allow <dir>`)'}`);
  console.log(`
Next steps:
  1. ramcp policy allow ~/projects     # what the AI may read/write
  2. ramcp policy shell on             # optional: allow commands
  3. ramcp tunnel                      # public https URL (laptops, no port forward)
     or: ramcp service install         # autostart on a server with a domain
`);
}

// ---------------------------------------------------------------------------
// start / tunnel
// ---------------------------------------------------------------------------
async function cmdStart(args: Args): Promise<void> {
  const { runServer } = await import('../server/run.js');
  await runServer({
    host: args.values.get('host'),
    port: args.values.has('port') ? parseInt(args.values.get('port')!, 10) : undefined,
    readOnly: args.flags.has('read-only'),
    tunnel: args.flags.has('tunnel'),
  });
}

async function cmdTunnel(args: Args): Promise<void> {
  const { runServer } = await import('../server/run.js');
  await runServer({
    host: args.values.get('host'),
    port: args.values.has('port') ? parseInt(args.values.get('port')!, 10) : undefined,
    readOnly: args.flags.has('read-only'),
    tunnel: true,
  });
}

// ---------------------------------------------------------------------------
// url
// ---------------------------------------------------------------------------
function cmdUrl(args: Args): void {
  const cfg = loadConfig();
  const t = findToken(cfg, args.sub[0] || args.values.get('token'));

  // A live tunnel (pid-checked) wins: its URL only exists while that
  // gateway process runs, and it is the address chatbots must use right now.
  const rt = readRuntimeState();
  if (rt?.tunnel_url) {
    const base = rt.tunnel_url.replace(/\/+$/, '');
    console.log(`${base}/${t.token}${cfg.mcp_path}`);
    console.log(`\n(live tunnel — pid ${rt.pid}, since ${rt.started})`);
    return;
  }

  const host = cfg.public_host || `${cfg.host}:${cfg.port}`;
  const scheme = cfg.public_host ? 'https' : 'http';
  console.log(`${scheme}://${host}/${t.token}${cfg.mcp_path}`);
  if (!cfg.public_host) {
    console.log('\n(local URL — run `ramcp tunnel` for a public https link)');
  }
}

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------
function cmdToken(args: Args): void {
  const cfg = loadConfig();
  const sub = args.sub[0];

  if (sub === 'list' || !sub) {
    if (jsonOut(args)) {
      console.log(JSON.stringify(cfg.tokens.map(t => ({
        id: t.id, name: t.name, created: t.created, expires: t.expires || null,
        scopes: t.scopes, read_only: !!t.read_only, shell: t.shell_enabled,
        allowed_paths: t.allowed_paths, denied_paths: t.denied_paths,
        rpm: t.max_requests_per_minute || null,
        fingerprint: AuditLog.fingerprint(t.token),
      })), null, 2));
      return;
    }
    for (const t of cfg.tokens) {
      const bits = [
        t.id,
        t.name.padEnd(16),
        `shell:${t.shell_enabled ? 'on ' : 'off'}`,
        `ro:${t.read_only ? 'yes' : 'no '}`,
        `paths:${t.allowed_paths.length}`,
        t.expires ? `expires:${t.expires.slice(0, 10)}` : '',
        t.scopes.length ? `scopes:${t.scopes.join('|')}` : '',
      ].filter(Boolean);
      console.log(bits.join('  '));
    }
    return;
  }

  if (sub === 'add') {
    const name = args.values.get('name') || args.sub[1];
    if (!name) { console.error('--name is required'); process.exit(1); }
    if (cfg.tokens.some(t => t.name === name)) { console.error(`Token "${name}" already exists`); process.exit(1); }
    const rec = newTokenRecord({
      name,
      shell_enabled: args.flags.has('shell') ? true : args.flags.has('no-shell') ? false : undefined,
      allowed_paths: splitList(args.values.get('paths')).map(resolveReal),
      denied_paths: splitList(args.values.get('deny')).map(resolveReal),
      scopes: splitList(args.values.get('scopes')),
      read_only: args.flags.has('read-only'),
      max_requests_per_minute: args.values.has('rpm') ? parseInt(args.values.get('rpm')!, 10) : undefined,
      expires: args.values.get('expires'),
    });
    cfg.tokens.push(rec);
    saveConfig(cfg);
    const host = cfg.public_host || `${cfg.host}:${cfg.port}`;
    const scheme = cfg.public_host ? 'https' : 'http';
    console.log(`Token "${name}" created (${rec.id})`);
    console.log(`URL: ${scheme}://${host}/${rec.token}${cfg.mcp_path}`);
    return;
  }

  if (sub === 'show') {
    const t = findToken(cfg, args.sub[1] || args.values.get('token'));
    console.log(args.flags.has('full') ? t.token : `${t.name}: ${mask(t.token)} (--full for the complete token)`);
    return;
  }

  if (sub === 'rotate') {
    const t = findToken(cfg, args.sub[1] || args.values.get('token'));
    t.token = generateToken();
    saveConfig(cfg);
    console.log(`Token "${t.name}" rotated: ${t.token}`);
    console.log('Old token is dead. Update your chatbot connector.');
    return;
  }

  if (sub === 'revoke') {
    const t = findToken(cfg, args.sub[1] || args.values.get('token'));
    if (cfg.tokens.length === 1) { console.error('Cannot revoke the last token.'); process.exit(1); }
    cfg.tokens = cfg.tokens.filter(x => x !== t);
    saveConfig(cfg);
    console.log(`Token "${t.name}" (${t.id}) revoked.`);
    return;
  }

  console.log('Usage: ramcp token <list|add|show|rotate|revoke> …');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// policy — multi-path, token-selectable
// ---------------------------------------------------------------------------
function cmdPolicy(args: Args): void {
  const cfg = loadConfig();
  const action = args.sub[0] || 'show';

  // Global switch (no token selector)
  if (action === 'readonly') {
    const val = args.sub[1];
    if (val !== 'on' && val !== 'off') { console.error('Usage: ramcp policy readonly on|off'); process.exit(1); }
    cfg.read_only = val === 'on';
    saveConfig(cfg);
    console.log(`Global read-only: ${cfg.read_only ? 'ON — all mutating tools refused' : 'off'}`);
    return;
  }

  const t = findToken(cfg, args.values.get('token'));
  const rest = args.sub.slice(1);

  if (action === 'allow' || action === 'deny') {
    const targets = [...rest, ...splitList(args.values.get('paths'))].map(resolveReal);
    if (!targets.length) { console.error(`Usage: ramcp policy ${action} <path> [path...] [--token N]`); process.exit(1); }
    for (const p of targets) {
      if (action === 'allow') {
        t.denied_paths = t.denied_paths.filter(d => d !== p);
        if (!t.allowed_paths.includes(p)) t.allowed_paths.push(p);
      } else {
        t.allowed_paths = t.allowed_paths.filter(a => a !== p);
        if (!t.denied_paths.includes(p)) t.denied_paths.push(p);
      }
    }
    saveConfig(cfg);
    console.log(`${action === 'allow' ? 'Allowed' : 'Denied'} for "${t.name}":`);
    for (const p of targets) console.log(`  ${p}`);
    return;
  }

  if (action === 'shell') {
    const val = rest[0];
    if (val !== 'on' && val !== 'off') { console.error('Usage: ramcp policy shell on|off [--token N]'); process.exit(1); }
    t.shell_enabled = val === 'on';
    saveConfig(cfg);
    console.log(`Shell for "${t.name}": ${t.shell_enabled ? 'enabled' : 'disabled'}`);
    return;
  }

  if (action === 'scopes') {
    const raw = rest.join(',') || args.values.get('scopes') || '';
    if (!raw) { console.error('Usage: ramcp policy scopes <group,group|all> [--token N]'); process.exit(1); }
    if (raw === 'all') {
      t.scopes = [];
    } else {
      const groups = splitList(raw);
      const unknown = groups.filter(g => !(g in TOOL_SCOPES));
      if (unknown.length) {
        console.error(`Unknown scope group(s): ${unknown.join(', ')}`);
        console.error(`Available: ${Object.keys(TOOL_SCOPES).join(', ')}`);
        process.exit(1);
      }
      t.scopes = groups;
    }
    saveConfig(cfg);
    console.log(`Scopes for "${t.name}": ${t.scopes.length ? t.scopes.join(', ') : '(all tools)'}`);
    return;
  }

  // show
  if (jsonOut(args)) {
    console.log(JSON.stringify({
      token: t.name, allowed_paths: t.allowed_paths, denied_paths: t.denied_paths,
      shell: t.shell_enabled, read_only: !!t.read_only, scopes: t.scopes,
      global_read_only: cfg.read_only,
    }, null, 2));
    return;
  }
  console.log(`token:      ${t.name} (${t.id})`);
  console.log(`allowed:    ${t.allowed_paths.length ? '\n  ' + t.allowed_paths.join('\n  ') : '(none — the AI can read nothing)'}`);
  console.log(`denied:     ${t.denied_paths.length ? '\n  ' + t.denied_paths.join('\n  ') : '(none)'}`);
  console.log(`shell:      ${t.shell_enabled ? 'enabled' : 'disabled'}`);
  console.log(`read_only:  ${t.read_only ? 'yes' : 'no'}${cfg.read_only ? '  (global read-only is ON)' : ''}`);
  console.log(`scopes:     ${t.scopes.length ? t.scopes.join(', ') : '(all tools)'}`);
}

function cmdScopes(): void {
  for (const [group, tools] of Object.entries(TOOL_SCOPES)) {
    console.log(`${group.padEnd(12)} ${tools.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------
function cmdAudit(args: Args): void {
  const cfg = loadConfig();
  if (!cfg.audit.enabled) { console.log('Audit log is disabled.'); return; }
  const audit = new AuditLog(cfg.audit.db_path);

  if (args.sub[0] === 'chain' || args.flags.has('verify')) {
    const bad = audit.verify();
    console.log(bad === null ? '✔ hash chain intact' : `✖ TAMPERED — first bad entry: line ${bad}`);
    process.exit(bad === null ? 0 : 2);
  }

  const rows = audit.query({
    tool: args.values.get('tool'),
    since: args.values.has('since') ? new Date(args.values.get('since')!).getTime() : undefined,
    limit: args.values.has('limit') ? parseInt(args.values.get('limit')!, 10) : 50,
  });
  if (jsonOut(args)) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.log('(no audit entries)'); return; }
  for (const r of rows) {
    console.log(`${new Date(r.ts).toISOString().slice(0, 19)}  fp:${r.token_fingerprint}  ${r.tool.padEnd(22)} ${r.is_error ? 'ERR' : 'ok '} ${r.duration_ms}ms`);
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
async function cmdDoctor(args: Args): Promise<void> {
  const results: Array<[string, string]> = [];
  const ok = (n: string, m: string) => results.push([`✔ ${n}`, m]);
  const bad = (n: string, m: string) => results.push([`✖ ${n}`, m]);
  const warn = (n: string, m: string) => results.push([`⚠ ${n}`, m]);

  const cfg = loadConfig();
  ok('platform', platformLabel());
  ok('config', configPath());

  if (cfg.tokens.length) {
    const withPaths = cfg.tokens.filter(t => t.allowed_paths.length).length;
    ok('tokens', `${cfg.tokens.length} configured, ${withPaths} with path access`);
    if (!withPaths) warn('paths', 'no token has any allowed path — add with `ramcp policy allow <dir>`');
  } else {
    bad('tokens', 'none — run `ramcp init`');
  }

  // port / gateway
  const inUse = await new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(cfg.port, cfg.host);
  });
  const svcActive = serviceIsActive();
  if (inUse) {
    try {
      const resp = await fetch(`http://${cfg.host}:${cfg.port}/health`, { signal: AbortSignal.timeout(4000) });
      const body = (await resp.json()) as { status?: string; version?: string };
      body.status === 'ok'
        ? ok('gateway', `healthy on ${cfg.host}:${cfg.port} (v${body.version})`)
        : bad('gateway', `unexpected reply: ${JSON.stringify(body)}`);
    } catch {
      warn('gateway', `port ${cfg.port} is in use but /health did not answer — another app?`);
    }
  } else {
    warn('gateway', `not running — start with \`ramcp tunnel\` or \`ramcp start\``);
  }
  if (svcActive) ok('service', `${serviceLabel()} active`);
  else if (serviceIsInstalled()) warn('service', `${serviceLabel()} installed but not active`);

  // tunnel readiness
  const cf = resolveCloudflared();
  cf ? ok('tunnel', `cloudflared ready (${cf})`) : warn('tunnel', 'cloudflared not installed yet — `ramcp tunnel` downloads it automatically');

  // live tunnel state (a running `ramcp tunnel` in another terminal)
  const rt = readRuntimeState();
  if (rt?.tunnel_url) {
    try {
      const resp = await fetch(`${rt.tunnel_url}/health`, { signal: AbortSignal.timeout(8000) });
      const body = (await resp.json()) as { status?: string };
      body.status === 'ok'
        ? ok('tunnel-live', `${rt.tunnel_url} (pid ${rt.pid})`)
        : warn('tunnel-live', `edge answered ${resp.status}`);
    } catch (e: any) {
      warn('tunnel-live', `runtime state says pid ${rt.pid}, but unreachable (${e.message})`);
    }
  }

  // public reachability
  if (cfg.public_host) {
    try {
      const resp = await fetch(`https://${cfg.public_host}/health`, { signal: AbortSignal.timeout(8000) });
      const body = (await resp.json()) as { status?: string };
      body.status === 'ok' ? ok('public', `https://${cfg.public_host} reachable`) : warn('public', `edge answered ${resp.status}`);
    } catch (e: any) {
      warn('public', `https://${cfg.public_host} unreachable (${e.message})`);
    }
  }

  // audit
  if (cfg.audit.enabled) {
    const file = cfg.audit.db_path.replace(/\.db$/, '') + (cfg.audit.db_path.endsWith('.jsonl') ? '' : '.jsonl');
    if (fs.existsSync(file) || fs.existsSync(cfg.audit.db_path)) {
      const a = new AuditLog(cfg.audit.db_path);
      const t = a.verify();
      t === null ? ok('audit', 'hash chain intact') : bad('audit', `tampered at line ${t}`);
    } else {
      warn('audit', 'enabled, no entries yet');
    }
  }

  for (const [n, m] of results) console.log(`${n.padEnd(14)} ${m}`);
  process.exitCode = results.some(r => r[0].startsWith('✖')) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// service — systemd / launchd / schtasks
// ---------------------------------------------------------------------------
const SERVICE_NAME = 'remote-access-mcp';
const SYSTEMD_FILE = `/etc/systemd/system/${SERVICE_NAME}.service`;
const LAUNCHD_LABEL = 'ir.amiralimanzar.ramcp';
const launchdFile = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const SCHTASK_NAME = 'RemoteAccessMCP';

function serviceLabel(): string {
  if (hasSystemd()) return 'systemd unit';
  if (isMac()) return 'launchd agent';
  if (isWindows()) return 'scheduled task';
  return 'service';
}

function serviceIsInstalled(): boolean {
  if (hasSystemd()) return fs.existsSync(SYSTEMD_FILE);
  if (isMac()) return fs.existsSync(launchdFile());
  if (isWindows()) return run('schtasks', ['/query', '/tn', SCHTASK_NAME]).length > 0;
  return false;
}

function serviceIsActive(): boolean {
  if (hasSystemd()) return run('systemctl', ['is-active', SERVICE_NAME]).trim() === 'active';
  if (isMac()) return run('launchctl', ['list']).includes(LAUNCHD_LABEL);
  if (isWindows()) return /Running/i.test(run('schtasks', ['/query', '/tn', SCHTASK_NAME, '/fo', 'LIST', '/v']));
  return false;
}

function cmdService(args: Args): void {
  const sub = args.sub[0] || '';
  if (sub === 'install') return installService(args);
  if (sub === 'uninstall') return uninstallService();
  if (sub === 'status') return cmdStatus();
  if (sub === 'logs') {
    if (hasSystemd()) {
      const f = args.flags.has('f') || args.flags.has('follow') ? ['-f'] : [];
      try { execFileSync('journalctl', ['-u', SERVICE_NAME, '-n', '100', ...f], { stdio: 'inherit' }); }
      catch (e: any) { console.error(e.message); process.exit(1); }
      return;
    }
    const log = path.join(configDir(), 'gateway.log');
    if (!fs.existsSync(log)) { console.log(`No log file at ${log}`); return; }
    if (args.flags.has('f') || args.flags.has('follow')) {
      console.log(`(following ${log} — Ctrl+C to stop)`);
      let size = fs.statSync(log).size;
      setInterval(() => {
        const s = fs.statSync(log).size;
        if (s > size) {
          const fd = fs.openSync(log, 'r');
          const buf = Buffer.alloc(s - size);
          fs.readSync(fd, buf, 0, buf.length, size);
          fs.closeSync(fd);
          process.stdout.write(buf.toString());
          size = s;
        }
      }, 700);
      return;
    }
    const content = fs.readFileSync(log, 'utf8').split('\n').slice(-100).join('\n');
    console.log(content);
    return;
  }
  console.log('Usage: ramcp service <install [--domain D]|uninstall|logs [-f]|status>');
  process.exit(1);
}

function installService(args: Args): void {
  const cfg = loadConfig();
  const nodeBin = process.execPath;
  const entry = path.join(PKG_ROOT, 'dist', 'server', 'run.js');
  const dryRun = args.flags.has('dry-run');
  const wantTunnel = args.flags.has('tunnel');
  const domain = args.values.get('domain') || '';

  // ---- Linux (systemd) ----
  if (hasSystemd()) {
    if (process.getuid?.() !== 0) { console.error('systemd install requires root (sudo).'); process.exit(1); }
    const unit = `[Unit]
Description=Remote Access MCP Gateway
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${entry}${wantTunnel ? ' --tunnel' : ''}
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=HOME=${os.homedir()}

[Install]
WantedBy=multi-user.target
`;
    if (dryRun) { console.log(`--- ${SYSTEMD_FILE} ---\n${unit}`); return; }
    fs.writeFileSync(SYSTEMD_FILE, unit);
    execFileSync('systemctl', ['daemon-reload']);
    execFileSync('systemctl', ['enable', '--now', SERVICE_NAME]);
    console.log(`✔ systemd service installed and started: ${SERVICE_NAME}`);
    if (domain) installNginx(domain, cfg, dryRun);
    else console.log('Tip: --domain mcp.example.com also writes an nginx vhost.');
    return;
  }

  // ---- macOS (launchd, per-user, no sudo) ----
  if (isMac()) {
    const out = path.join(configDir(), 'gateway.log');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${entry}</string>${wantTunnel ? '\n    <string>--tunnel</string>' : ''}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${out}</string>
  <key>StandardErrorPath</key><string>${out}</string>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>${os.homedir()}</string></dict>
</dict>
</plist>
`;
    if (dryRun) { console.log(`--- ${launchdFile()} ---\n${plist}`); return; }
    fs.mkdirSync(path.dirname(launchdFile()), { recursive: true });
    fs.writeFileSync(launchdFile(), plist);
    run('launchctl', ['unload', launchdFile()]);
    execFileSync('launchctl', ['load', '-w', launchdFile()]);
    console.log(`✔ launchd agent installed: ${LAUNCHD_LABEL}`);
    console.log(`  logs: ${out}`);
    return;
  }

  // ---- Windows (Scheduled Task at logon, no admin needed) ----
  if (isWindows()) {
    const log = path.join(configDir(), 'gateway.log');
    const cmd = `"${nodeBin}" "${entry}"${wantTunnel ? ' --tunnel' : ''}`;
    if (dryRun) {
      console.log(`schtasks /create /tn ${SCHTASK_NAME} /tr ${cmd} /sc onlogon /rl limited /f`);
      return;
    }
    try {
      execFileSync('schtasks', ['/create', '/tn', SCHTASK_NAME, '/tr', cmd, '/sc', 'onlogon', '/rl', 'limited', '/f'], { stdio: 'inherit' });
      execFileSync('schtasks', ['/run', '/tn', SCHTASK_NAME], { stdio: 'inherit' });
      console.log(`✔ scheduled task installed and started: ${SCHTASK_NAME}`);
      console.log(`  logs: ${log}`);
    } catch (e: any) {
      console.error(`schtasks failed: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  console.error(`No supported service manager on ${platform()}. Run \`ramcp start\` manually or use your own supervisor.`);
  process.exit(1);
}

function installNginx(domain: string, cfg: RamcpConfig, dryRun: boolean): void {
  const nginxFile = `/etc/nginx/sites-available/${domain}`;
  const vhost = `server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    # TLS terminates upstream (Cloudflare/CDN or your own LB).
    location / {
        proxy_pass http://${cfg.host}:${cfg.port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE / streaming support — critical for MCP Streamable HTTP
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        client_max_body_size 64m;
    }

    access_log /var/log/nginx/${domain}.access.log;
    error_log  /var/log/nginx/${domain}.error.log;
}
`;
  if (dryRun) { console.log(`--- ${nginxFile} ---\n${vhost}`); return; }
  fs.writeFileSync(nginxFile, vhost);
  const link = `/etc/nginx/sites-enabled/${domain}`;
  if (!fs.existsSync(link)) fs.symlinkSync(nginxFile, link);
  try {
    execFileSync('nginx', ['-t']);
    execFileSync('systemctl', ['reload', 'nginx']);
    console.log(`✔ nginx vhost installed: ${domain} → ${cfg.host}:${cfg.port}`);
  } catch (e: any) {
    console.error(`nginx config test failed:\n${e.stdout || e.message}`);
    process.exit(1);
  }
}

function uninstallService(): void {
  if (hasSystemd()) {
    if (process.getuid?.() !== 0) { console.error('uninstall requires root (sudo).'); process.exit(1); }
    if (fs.existsSync(SYSTEMD_FILE)) {
      run('systemctl', ['disable', '--now', SERVICE_NAME]);
      fs.unlinkSync(SYSTEMD_FILE);
      execFileSync('systemctl', ['daemon-reload']);
      console.log('✔ systemd service removed');
    } else console.log('Service not installed.');
    const sitesDir = '/etc/nginx/sites-enabled';
    if (fs.existsSync(sitesDir)) {
      const cfg = loadConfig();
      for (const f of fs.readdirSync(sitesDir)) {
        try {
          if (fs.readFileSync(path.join(sitesDir, f), 'utf8').includes(`proxy_pass http://${cfg.host}:${cfg.port}`)) {
            fs.unlinkSync(path.join(sitesDir, f));
            console.log(`✔ nginx vhost removed: ${f}`);
          }
        } catch { /* skip */ }
      }
      run('nginx', ['-t']) && run('systemctl', ['reload', 'nginx']);
    }
    return;
  }
  if (isMac()) {
    if (fs.existsSync(launchdFile())) {
      run('launchctl', ['unload', '-w', launchdFile()]);
      fs.unlinkSync(launchdFile());
      console.log('✔ launchd agent removed');
    } else console.log('Agent not installed.');
    return;
  }
  if (isWindows()) {
    try {
      execFileSync('schtasks', ['/delete', '/tn', SCHTASK_NAME, '/f'], { stdio: 'inherit' });
      console.log('✔ scheduled task removed');
    } catch { console.log('Task not installed.'); }
    return;
  }
  console.log(`Nothing to uninstall on ${platform()}.`);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
function cmdStatus(): void {
  const cfg = loadConfig();
  const rt = readRuntimeState();
  console.log(`platform:          ${platformLabel()}`);
  console.log(`config:            ${configPath()}`);
  console.log(`${serviceLabel()}:${' '.repeat(Math.max(1, 19 - serviceLabel().length - 1))}${serviceIsInstalled() ? (serviceIsActive() ? 'installed, active' : 'installed, inactive') : 'not installed'}`);
  console.log(`listen:            ${cfg.host}:${cfg.port}${cfg.mcp_path}`);
  console.log(`gateway process:   ${rt ? `running (pid ${rt.pid})` : 'not running'}`);
  console.log(`public_host:       ${cfg.public_host || '(none — use `ramcp tunnel`)'}`);
  console.log(`live tunnel:       ${rt?.tunnel_url || '(none)'}`);
  console.log(`tokens:            ${cfg.tokens.length}`);
  console.log(`allowed paths:     ${cfg.tokens.reduce((n, t) => n + t.allowed_paths.length, 0)}`);
  console.log(`audit:             ${cfg.audit.enabled ? 'on' : 'off'}`);
  console.log(`read_only:         ${cfg.read_only ? 'on' : 'off'}`);
}

// ---------------------------------------------------------------------------
// schedule / upgrade
// ---------------------------------------------------------------------------
function cmdSchedule(args: Args): void {
  const p = path.join(configDir(), 'schedule.json');
  if (jsonOut(args)) { console.log(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '[]'); return; }
  try {
    const tasks = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!tasks.length) { console.log('(no scheduled tasks)'); return; }
    for (const t of tasks) console.log(`${t.id} | ${t.enabled ? 'on' : 'off'} | ${t.command} | next: ${t.next_run || t.run_at || '-'}`);
  } catch { console.log('(no scheduled tasks)'); }
}

async function cmdUpgrade(args: Args): Promise<void> {
  console.log(`current: v${PKG.version}`);
  const latest = await fetch('https://registry.npmjs.org/remote-access-mcp/latest')
    .then(r => r.json()).then((j: unknown) => (j as { version: string }).version)
    .catch(() => null);
  if (!latest) { console.error('could not reach npm registry'); process.exit(1); }
  if (latest === PKG.version) { console.log('already up to date'); return; }
  console.log(`latest:  v${latest}`);
  if (args.flags.has('dry-run')) { console.log('(dry-run — no changes)'); return; }
  if (isLinux() && process.getuid?.() !== 0) { console.error('upgrade requires root (sudo) for a global npm install'); process.exit(1); }
  execFileSync('npm', ['install', '-g', `remote-access-mcp@${latest}`], { stdio: 'inherit' });
  if (serviceIsInstalled()) {
    if (hasSystemd()) run('systemctl', ['restart', SERVICE_NAME]);
    else if (isMac()) { run('launchctl', ['unload', launchdFile()]); run('launchctl', ['load', '-w', launchdFile()]); }
    else if (isWindows()) { run('schtasks', ['/end', '/tn', SCHTASK_NAME]); run('schtasks', ['/run', '/tn', SCHTASK_NAME]); }
    console.log(`service restarted on v${latest}`);
  }
}

// ---------------------------------------------------------------------------
// webhook — outbound notifications
// ---------------------------------------------------------------------------
function cmdWebhook(args: Args): void {
  const cfg = loadConfig();
  const sub = args.sub[0] || 'list';

  if (sub === 'add') {
    const url = args.values.get('url');
    if (!url || !/^https?:\/\//.test(url)) { console.error('Usage: ramcp webhook add --url https://… [--events tool.error,tool.success]'); process.exit(1); }
    const events = splitList(args.values.get('events') || 'tool.error');
    cfg.webhooks!.push({ url, events, enabled: true });
    saveConfig(cfg);
    console.log(`✔ webhook added: ${url}`);
    console.log(`  events: ${events.join(', ')}`);
    console.log(`  (fires fire-and-forget after tool calls; 5s timeout, deduped within 10s)`);
    return;
  }

  if (sub === 'remove') {
    const i = cfg.webhooks!.findIndex(w => w.url === args.sub[1]);
    if (i === -1) { console.error('No webhook with that URL.'); process.exit(1); }
    cfg.webhooks!.splice(i, 1);
    saveConfig(cfg);
    console.log('✔ removed');
    return;
  }

  if (sub === 'off' || sub === 'on') {
    const w = cfg.webhooks!.find(w => w.url === args.sub[1]);
    if (!w) { console.error('No webhook with that URL.'); process.exit(1); }
    w.enabled = sub === 'on';
    saveConfig(cfg);
    console.log(`✔ ${w.url} ${w.enabled ? 'enabled' : 'disabled'}`);
    return;
  }

  // list
  const stats = webhookStats();
  if (!cfg.webhooks!.length) { console.log('(no webhooks — add with `ramcp webhook add --url …`)'); return; }
  for (const w of cfg.webhooks!) {
    console.log(`${w.enabled ? '✔' : '⏸'}  ${w.url}`);
    console.log(`     events: ${w.events.join(', ')}`);
  }
  console.log(`\nsession stats: sent=${stats.sent} failed=${stats.failed}`);
}

// ---------------------------------------------------------------------------
// config — export / import / show
// ---------------------------------------------------------------------------
function cmdConfig(args: Args): void {
  const cfg = loadConfig();
  const sub = args.sub[0] || 'show';

  if (sub === 'export') {
    const out = args.values.get('out') || 'ramcp-export.json';
    const snapshot = JSON.parse(JSON.stringify(cfg)) as typeof cfg;
    // strip nothing — export is a full backup by design; tokens are the
    // secrets that make the backup useful. Warn loudly instead.
    fs.writeFileSync(out, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    console.log(`✔ exported ${cfg.tokens.length} token(s), ${(cfg.webhooks || []).length} webhook(s) → ${out}`);
    console.log('⚠ this file contains live tokens — store it encrypted and delete when done.');
    return;
  }

  if (sub === 'import') {
    const file = args.sub[1];
    if (!file) { console.error('Usage: ramcp config import <file> [--merge]'); process.exit(1); }
    let incoming: RamcpConfig;
    try { incoming = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e: any) { console.error(`cannot read ${file}: ${e.message}`); process.exit(1); }
    if (!Array.isArray(incoming.tokens)) { console.error('not a ramcp export (no tokens array)'); process.exit(1); }
    if (args.flags.has('merge')) {
      // merge: keep local identity (host/port/domain/paths), union tokens,
      // add webhooks that are new.
      const existingUrls = new Set((cfg.webhooks || []).map(w => w.url));
      for (const w of incoming.webhooks || []) if (!existingUrls.has(w.url)) cfg.webhooks!.push(w);
      for (const t of incoming.tokens) if (!cfg.tokens.some(x => x.token === t.token)) cfg.tokens.push(t);
      saveConfig(cfg);
      console.log('✔ merged (local host/port/domain and existing entries preserved)');
    } else {
      saveConfig(incoming);
      console.log(`✔ imported ${incoming.tokens.length} token(s) — replaced existing config`);
      console.log('(restart the service or reconnect clients to apply)');
    }
    return;
  }

  // show
  console.log(JSON.stringify(cfg, null, 2));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.flags.has('h') || args.flags.has('help')) { console.log(HELP); process.exit(0); }

  switch (args.command) {
    case 'init': cmdInit(args); break;
    case 'start': await cmdStart(args); break;
    case 'tunnel': await cmdTunnel(args); break;
    case 'url': cmdUrl(args); break;
    case 'token': cmdToken(args); break;
    case 'policy': cmdPolicy(args); break;
    case 'scopes': cmdScopes(); break;
    case 'audit': cmdAudit(args); break;
    case 'doctor': await cmdDoctor(args); break;
    case 'service': cmdService(args); break;
    case 'status': cmdStatus(); break;
    case 'schedule': cmdSchedule(args); break;
    case 'upgrade': await cmdUpgrade(args); break;
    case 'webhook': cmdWebhook(args); break;
    case 'config': cmdConfig(args); break;
    case 'version': console.log(PKG.version); break;
    case '': console.log(HELP); process.exit(0); break;
    default:
      console.error(`Unknown command: ${args.command}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
