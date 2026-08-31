import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import {
  loadConfig, saveConfig, loadLiveConfig, generateToken, newTokenRecord,
  configPath, configDir, resolveToken, primaryToken,
  type RamcpConfig, type TokenRecord,
} from '../core/config.js';
import { resolveReal } from '../core/policy.js';
import { AuditLog, redactArgs } from '../core/audit.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------
const HELP = `${PKG.name} v${PKG.version} — turn any Linux server into an AI-agent-accessible machine

Usage:
  ramcp <command> [options]

Commands:
  init                          Generate config + first token (safe to re-run)
  start [--host H] [--port P]
      [--read-only]            Run the gateway in the foreground
  url [--token ID|name]         Print the MCP connector URL for chatbots
  status                        Service status summary
  doctor                        Diagnose token, port, nginx, DNS in one pass
  version                       Print version

  token list [--json]           List tokens (fingerprints only)
  token add --name N [opts]      Create a token (see options below)
  token show [ID|name] [--full]  Show a token
  token rotate [ID|name]         Rotate a token (old one dies instantly)
  token revoke ID|name           Revoke (delete) a token
  token add options:
      --shell / --no-shell       shell execution (default: off)
      --paths a,b,c              allowed paths (comma-separated)
      --deny a,b                 denied paths
      --scopes group,group       tool groups (empty = all)
      --read-only                refuse mutating tools
      --rpm N                    max requests per minute
      --expires YYYY-MM-DD       expiry date

  policy [ID|name]               Show a token's policy
  policy allow <path>            Allow a path (default token)
  policy deny <path>             Deny a path
  policy shell on|off            Enable/disable shell (default token)
  policy readonly on|off         Global read-only kill-switch

  audit [query] [--tool T] [--since ISO] [--limit N]
      [--verify] [--json]       Query the tamper-evident audit log
  audit chain                    Verify hash-chain integrity

  service install [--domain D]    Install systemd unit (+ nginx vhost)
  service uninstall               Remove service + nginx vhost
  service logs [-f]               Tail gateway logs
  service status                  Detailed service check

  schedule list                   List scheduled tasks

Options:
  -h, --help                    Show this help
  --json                         Machine-readable output (where supported)
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
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        values.set(key, next);
        i++;
      } else {
        flags.add(key);
      }
    } else if (a.startsWith('-') && a.length > 1) {
      for (const c of a.slice(1)) flags.add(c);
    } else {
      sub.push(a);
    }
  }
  return { command, sub, flags, values };
}

const jsonOut = (args: Args) => args.flags.has('json');

// ---------------------------------------------------------------------------
// token lookup helper
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

function maskToken(t: string): string {
  return t.slice(0, 6) + '…' + t.slice(-4);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
function cmdInit(args: Args): void {
  const existing = fs.existsSync(configPath());
  const cfg = existing ? loadConfig() : null;
  if (cfg && cfg.tokens.length) {
    console.log('Config already exists with ' + cfg.tokens.length + ' token(s) — nothing to do.');
    console.log('Add more tokens with: ramcp token add --name <name>');
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
  const rec = newTokenRecord({ name: 'default' });
  fresh.tokens.push(rec);
  saveConfig(fresh);

  console.log(`
  ___                        _____
 | _ \\__ _ __ _ ___ _ _   |_   _|__ _ _ _ __ _ ___
 |   / _\` / _\` / -_) '_|    | |/ - \\ '_| '_/ _\` / -_)
 |_|_\\__,_\\__, \\___|_|      |_|\\___/_| |_| \\__,_\\___|
          |___/         ${PKG.name} v${PKG.version}

${existing ? '✔ Existing config migrated to v2' : '✔ Config written to ' + configPath()}
✔ Token "default": ${maskToken(rec.token)} (full: ramcp token show default --full)
✔ Audit log: ${fresh.audit.enabled ? 'enabled' : 'disabled'} (${fresh.audit.db_path})

Next steps:
  1. ramcp start                     # run in foreground
  2. ramcp service install           # systemd + nginx (production)
  3. ramcp policy allow /srv/myapp   # let the AI touch your project
  4. ramcp url                       # connector URL for your chatbot
`);
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------
async function cmdStart(args: Args): Promise<void> {
  const { runServer } = await import('../server/run.js');
  await runServer({
    host: args.values.get('host'),
    port: args.values.has('port') ? parseInt(args.values.get('port')!, 10) : undefined,
    readOnly: args.flags.has('read-only'),
  });
}

// ---------------------------------------------------------------------------
// url
// ---------------------------------------------------------------------------
function cmdUrl(args: Args): void {
  const cfg = loadConfig();
  const t = findToken(cfg, args.sub[0]);
  const host = cfg.public_host || `${cfg.host}:${cfg.port}`;
  const scheme = cfg.public_host ? 'https' : 'http';
  console.log(`${scheme}://${host}/${t.token}${cfg.mcp_path}`);
}

// ---------------------------------------------------------------------------
// token management
// ---------------------------------------------------------------------------
function cmdToken(args: Args): void {
  const cfg = loadConfig();
  const sub = args.sub[0];

  if (sub === 'list') {
    if (jsonOut(args)) {
      console.log(JSON.stringify(cfg.tokens.map(t => ({
        id: t.id, name: t.name, created: t.created, expires: t.expires || null,
        scopes: t.scopes, read_only: !!t.read_only, shell: t.shell_enabled,
        fingerprint: AuditLog.fingerprint(t.token),
      })), null, 2));
      return;
    }
    for (const t of cfg.tokens) {
      console.log(`${t.id}  ${t.name.padEnd(16)} shell:${t.shell_enabled ? 'on ' : 'off'} ro:${t.read_only ? 'yes' : 'no '} ${t.expires ? 'expires ' + t.expires + ' ' : ''}${t.scopes.length ? 'scopes: ' + t.scopes.join(',') + ' ' : ''}fp:${AuditLog.fingerprint(t.token)}`);
    }
    return;
  }

  if (sub === 'add') {
    const name = args.values.get('name');
    if (!name) { console.error('--name is required'); process.exit(1); }
    if (cfg.tokens.some(t => t.name === name)) { console.error(`Token "${name}" already exists`); process.exit(1); }
    const rec = newTokenRecord({
      name,
      shell_enabled: args.flags.has('shell') ? true : args.flags.has('no-shell') ? false : undefined,
      allowed_paths: args.values.get('paths')?.split(',').map(s => s.trim()).filter(Boolean),
      denied_paths: args.values.get('deny')?.split(',').map(s => s.trim()).filter(Boolean),
      scopes: args.values.get('scopes')?.split(',').map(s => s.trim()).filter(Boolean),
      read_only: args.flags.has('read-only'),
      max_requests_per_minute: args.values.has('rpm') ? parseInt(args.values.get('rpm')!, 10) : undefined,
      expires: args.values.get('expires'),
    });
    // resolve allowed paths to real paths
    rec.allowed_paths = rec.allowed_paths.map(resolveReal);
    rec.denied_paths = rec.denied_paths.map(resolveReal);
    cfg.tokens.push(rec);
    saveConfig(cfg);
    console.log(`Token "${name}" created (${rec.id})`);
    console.log(`URL: https://${cfg.public_host || cfg.host + ':' + cfg.port}/${rec.token}${cfg.mcp_path}`);
    restartHint();
    return;
  }

  if (sub === 'show') {
    const t = findToken(cfg, args.sub[1]);
    if (args.flags.has('full')) console.log(t.token);
    else console.log(`${t.name}: ${maskToken(t.token)} (use --full for the complete token)`);
    return;
  }

  if (sub === 'rotate') {
    const t = findToken(cfg, args.sub[1]);
    t.token = generateToken();
    saveConfig(cfg);
    console.log(`Token "${t.name}" rotated: ${t.token}`);
    console.log('Old token is dead. Update your chatbot connector now.');
    restartHint();
    return;
  }

  if (sub === 'revoke') {
    const t = findToken(cfg, args.sub[1]);
    cfg.tokens = cfg.tokens.filter(x => x !== t);
    if (!cfg.tokens.length) { console.error('Cannot revoke the last token.'); process.exit(1); }
    saveConfig(cfg);
    console.log(`Token "${t.name}" (${t.id}) revoked.`);
    restartHint();
    return;
  }

  console.log('Usage: ramcp token <list|add|show|rotate|revoke> …');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------
function cmdPolicy(args: Args): void {
  const cfg = loadConfig();
  // global readonly toggle has no token selector
  if (args.sub[0] === 'readonly' && (args.sub[1] === 'on' || args.sub[1] === 'off')) {
    cfg.read_only = args.sub[1] === 'on';
    saveConfig(cfg);
    console.log(`Global read-only: ${cfg.read_only ? 'ON — mutating tools refused' : 'off'}`);
    restartHint();
    return;
  }
  const t = findToken(cfg, args.sub[0] === 'allow' || args.sub[0] === 'deny' || args.sub[0] === 'shell' ? undefined : args.sub[0]);
  const sub = args.sub[0] === 'allow' || args.sub[0] === 'deny' || args.sub[0] === 'shell' ? args.sub[0] : (args.sub[1] || 'show');

  if (sub === 'allow' && args.values.size === 0 && !args.sub.find(s => s.startsWith('/'))) {
    // ramcp policy allow <path> — path is in sub[1] (or sub[2] when selector given)
  }

  const pathArg = (() => {
    const idx = args.sub.indexOf('allow') >= 0 ? args.sub.indexOf('allow') : args.sub.indexOf('deny');
    return idx >= 0 ? args.sub[idx + 1] : undefined;
  })();

  if (sub === 'allow' && pathArg) {
    const real = resolveReal(pathArg);
    if (!t.allowed_paths.includes(real)) t.allowed_paths.push(real);
    saveConfig(cfg);
    console.log(`Allowed: ${real}`);
    restartHint();
  } else if (sub === 'deny' && pathArg) {
    const real = resolveReal(pathArg);
    t.allowed_paths = t.allowed_paths.filter((p: string) => p !== real);
    if (!t.denied_paths.includes(real)) t.denied_paths.push(real);
    saveConfig(cfg);
    console.log(`Denied: ${real}`);
    restartHint();
  } else if (sub === 'shell' && (args.sub.includes('on') || args.sub.includes('off'))) {
    t.shell_enabled = args.sub.includes('on');
    saveConfig(cfg);
    console.log(`Shell execution for "${t.name}": ${t.shell_enabled ? 'enabled' : 'disabled'}`);
    restartHint();
  } else {
    console.log(`token:     ${t.name} (${t.id})`);
    console.log(`allowed:   ${t.allowed_paths.length ? '\n  ' + t.allowed_paths.join('\n  ') : '(none)'}`);
    console.log(`denied:    ${t.denied_paths.length ? '\n  ' + t.denied_paths.join('\n  ') : '(none)'}`);
    console.log(`shell:     ${t.shell_enabled ? 'enabled' : 'disabled'}`);
    console.log(`read_only: ${t.read_only ? 'yes' : 'no'}`);
    console.log(`scopes:    ${t.scopes.length ? t.scopes.join(', ') : '(all tools)'}`);
  }
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------
function cmdAudit(args: Args): void {
  const cfg = loadConfig();
  if (!cfg.audit.enabled) { console.log('Audit log is disabled (audit.enabled = false).'); return; }
  const audit = new AuditLog(cfg.audit.db_path);

  if (args.sub[0] === 'chain' || args.flags.has('verify')) {
    const tampered = audit.verify();
    console.log(tampered === null ? '✔ hash chain intact' : `✖ TAMPERED — first bad row id: ${tampered}`);
    process.exit(tampered === null ? 0 : 2);
  }

  const rows = audit.query({
    tool: args.values.get('tool'),
    since: args.values.has('since') ? new Date(args.values.get('since')!).getTime() : undefined,
    limit: args.values.has('limit') ? parseInt(args.values.get('limit')!, 10) : 50,
  });
  if (jsonOut(args)) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    if (!rows.length) { console.log('(no audit entries)'); return; }
    for (const r of rows) {
      const d = new Date(r.ts).toISOString().slice(0, 19);
      console.log(`${d}  fp:${r.token_fingerprint}  ${r.tool.padEnd(20)} ${r.is_error ? 'ERR ' : 'ok  '} ${r.duration_ms}ms`);
    }
  }
  audit.close();
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
async function cmdDoctor(args: Args): Promise<void> {
  const results: Array<[string, string]> = [];
  const ok = (name: string, msg: string) => results.push([`✔ ${name}`, msg]);
  const bad = (name: string, msg: string) => results.push([`✖ ${name}`, msg]);
  const warn = (name: string, msg: string) => results.push([`⚠ ${name}`, msg]);

  const cfg = loadConfig();

  // 1. token
  if (cfg.tokens.length) ok('tokens', `${cfg.tokens.length} configured, primary: ${cfg.tokens[0].name}`);
  else bad('tokens', 'none — run `ramcp init`');

  // 2. bind port free?
  const inUse = await new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => { srv.close(() => resolve(false)); });
    srv.listen(cfg.port, cfg.host);
  });
  const serviceActive = fs.existsSync(SERVICE_FILE) && run('systemctl', ['is-active', SERVICE_NAME]).trim() === 'active';
  if (inUse) {
    serviceActive ? ok('port', `${cfg.host}:${cfg.port} in use by the running service`) : warn('port', `${cfg.host}:${cfg.port} in use by ANOTHER process`);
  } else {
    serviceActive ? warn('port', `port free but service claims active — crashed?`) : warn('port', `not listening — start with \`ramcp service install\` or \`ramcp start\``);
  }

  // 3. gateway answers?
  if (!inUse || serviceActive) {
    try {
      const resp = await fetch(`http://${cfg.host}:${cfg.port}/health`);
      const body = (await resp.json()) as { status?: string; version?: string };
      if (body.status === 'ok') ok('gateway', `healthy (v${body.version})`);
      else bad('gateway', `unexpected: ${JSON.stringify(body)}`);
    } catch {
      bad('gateway', `no answer on ${cfg.host}:${cfg.port}/health`);
    }
  }

  // 4. nginx vhost?
  if (cfg.public_host) {
    const vhost = `/etc/nginx/sites-enabled/${cfg.public_host}`;
    if (fs.existsSync(vhost)) {
      const conf = fs.readFileSync(vhost, 'utf8');
      if (conf.includes(`proxy_pass http://${cfg.host}:${cfg.port}`)) {
        ok('nginx', `vhost for ${cfg.public_host} → ${cfg.host}:${cfg.port}`);
      } else {
        warn('nginx', `${vhost} exists but does not proxy to ${cfg.host}:${cfg.port}`);
      }
    } else {
      warn('nginx', `no vhost at ${vhost} — run \`ramcp service install --domain ${cfg.public_host}\``);
    }
    // 5. public DNS resolves + Cloudflare edge reachable?
    try {
      const resp = await fetch(`https://${cfg.public_host}/health`, { signal: AbortSignal.timeout(8000) });
      const body = (await resp.json()) as { status?: string };
      if (body.status === 'ok') ok('public', `https://${cfg.public_host} healthy end-to-end`);
      else warn('public', `got status ${resp.status} from edge`);
    } catch (e: any) {
      warn('public', `https://${cfg.public_host} unreachable: ${e.message}`);
    }
  }

  // 6. audit chain
  if (cfg.audit.enabled && fs.existsSync(cfg.audit.db_path.replace(/\.db$/, '') + '.jsonl')) {
    const audit = new AuditLog(cfg.audit.db_path);
    const tampered = audit.verify();
    tampered === null ? ok('audit', 'hash chain intact') : bad('audit', `tampered at row ${tampered}`);
    audit.close();
  } else if (cfg.audit.enabled) {
    warn('audit', 'enabled but db not created yet');
  }

  for (const [name, msg] of results) console.log(`${name.padEnd(14)} ${msg}`);
  const hasBad = results.some(r => r[0].startsWith('✖'));
  process.exitCode = hasBad ? 1 : 0;
}

function run(cmd: string, args: string[]): string {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------
const SERVICE_NAME = 'remote-access-mcp';
const SERVICE_FILE = `/etc/systemd/system/${SERVICE_NAME}.service`;

function isSystemdInstalled(): boolean {
  return fs.existsSync(SERVICE_FILE);
}

function restartHint(): void {
  if (isSystemdInstalled()) {
    console.log('(service restarts automatically on next request — config hot-reloads)');
  }
}

function cmdService(args: Args): void {
  const sub = args.sub[0] || '';

  if (sub === 'install') {
    installService(args);
  } else if (sub === 'uninstall') {
    uninstallService();
  } else if (sub === 'logs') {
    const flags = args.flags.has('f') || args.flags.has('follow') ? ['-f'] : [];
    try {
      execFileSync('journalctl', ['-u', SERVICE_NAME, '-n', '100', ...flags], { stdio: 'inherit' });
    } catch (e: any) { console.error(e.message); process.exit(1); }
  } else if (sub === 'status') {
    cmdStatus();
  } else {
    console.log('Usage: ramcp service <install [--domain D]|uninstall|logs [-f]|status>');
    process.exit(1);
  }
}

function installService(args: Args): void {
  if (process.getuid?.() !== 0) {
    console.error('service install requires root (sudo).');
    process.exit(1);
  }
  const domain = args.values.get('domain') || '';
  const cfg = loadConfig();
  const nodeBin = process.execPath;
  const pkgRoot = PKG_ROOT;

  const unit = `[Unit]
Description=Remote Access MCP Gateway
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${pkgRoot}/dist/server/run.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;
  fs.writeFileSync(SERVICE_FILE, unit);
  execFileSync('systemctl', ['daemon-reload']);
  execFileSync('systemctl', ['enable', '--now', SERVICE_NAME]);
  console.log(`✔ systemd service installed and started: ${SERVICE_NAME}`);

  if (domain) {
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
  } else {
    console.log('Note: pass --domain mcp.example.com to also install the nginx vhost.');
  }
}

function uninstallService(): void {
  if (process.getuid?.() !== 0) {
    console.error('service uninstall requires root (sudo).');
    process.exit(1);
  }
  if (fs.existsSync(SERVICE_FILE)) {
    try { execFileSync('systemctl', ['disable', '--now', SERVICE_NAME]); } catch { /* not running */ }
    fs.unlinkSync(SERVICE_FILE);
    execFileSync('systemctl', ['daemon-reload']);
    console.log(`✔ systemd service removed`);
  } else {
    console.log('Service not installed.');
  }
  const sitesDir = '/etc/nginx/sites-enabled';
  if (fs.existsSync(sitesDir)) {
    const cfg = loadConfig();
    for (const f of fs.readdirSync(sitesDir)) {
      try {
        const content = fs.readFileSync(path.join(sitesDir, f), 'utf8');
        if (content.includes(`proxy_pass http://${cfg.host}:${cfg.port}`)) {
          fs.unlinkSync(path.join(sitesDir, f));
          console.log(`✔ nginx vhost removed: ${f}`);
        }
      } catch { /* skip unreadable */ }
    }
    try {
      execFileSync('nginx', ['-t']);
      execFileSync('systemctl', ['reload', 'nginx']);
    } catch { /* nginx may be absent */ }
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
function cmdStatus(): void {
  const installed = isSystemdInstalled();
  console.log(`service installed: ${installed ? 'yes' : 'no'}`);
  if (installed) {
    console.log(`service status:   ${run('systemctl', ['is-active', SERVICE_NAME]).trim() || 'unknown'}`);
  }
  const cfg = loadConfig();
  console.log(`listen:           ${cfg.host}:${cfg.port}`);
  console.log(`tokens:           ${cfg.tokens.length}`);
  console.log(`audit:            ${cfg.audit.enabled ? 'on' : 'off'}`);
  console.log(`read_only:        ${cfg.read_only ? 'on' : 'off'}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.flags.has('h') || args.flags.has('help')) {
    console.log(HELP);
    process.exit(0);
  }

  switch (args.command) {
    case 'init': cmdInit(args); break;
    case 'start': await cmdStart(args); break;
    case 'url': cmdUrl(args); break;
    case 'token': cmdToken(args); break;
    case 'policy': cmdPolicy(args); break;
    case 'audit': cmdAudit(args); break;
    case 'doctor': await cmdDoctor(args); break;
    case 'service': cmdService(args); break;
    case 'status': cmdStatus(); break;
    case 'version': console.log(PKG.version); break;
    case '': console.log(HELP); process.exit(0); break;
    default:
      console.error(`Unknown command: ${args.command}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
