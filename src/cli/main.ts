import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  loadConfig, saveConfig, generateToken, configPath, configDir,
  type RamcpConfig,
} from '../core/config.js';
import { resolveReal } from '../core/policy.js';

const PKG = { name: 'remote-access-mcp', version: '1.0.0' };

// ---------------------------------------------------------------------------
// help text
// ---------------------------------------------------------------------------
const HELP = `${PKG.name} v${PKG.version} — turn any Linux server into an AI-agent-accessible machine

Usage:
  ramcp <command> [options]

Commands:
  init                        Generate config + token (safe to re-run)
  start [--host H] [--port P] Run the gateway in the foreground
  url                         Print the MCP connector URL for chatbots
  status                      Check whether the systemd service is running
  token rotate                Generate a new token (old one dies instantly)
  token show [--full]         Show the current token (masked unless --full)
  policy                      Show the path policy + shell flag
  policy allow <path>          Allow the AI access to a directory
  policy deny <path>           Deny a directory (removes it from allowed)
  policy shell on|off          Enable or disable shell execution
  service install              Install systemd unit + nginx vhost
  service uninstall            Remove systemd unit + nginx vhost
  service logs [-f]            Tail gateway logs (journalctl wrapper)
  version                      Print version

Options:
  -h, --help                  Show this help
`;

// ---------------------------------------------------------------------------
// tiny arg parser
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

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
function cmdInit(): void {
  const existing = fs.existsSync(configPath());
  let cfg: RamcpConfig;
  if (existing) {
    cfg = loadConfig();
    if (!cfg.token) cfg.token = generateToken();
  } else {
    cfg = {
      ...loadConfig(),
      token: generateToken(),
    };
  }
  saveConfig(cfg);

  const masked = cfg.token.slice(0, 6) + '…' + cfg.token.slice(-4);
  console.log(`
  ___                        _____
 | _ \\__ _ __ _ ___ _ _   |_   _|__ _ _ _ __ _ ___
 |   / _\` / _\` / -_) '_|    | |/ - \\ '_| '_/ _\` / -_)
 |_|_\\__,_\\__, \\___|_|      |_|\\___/_| |_| \\__,_\\___|
          |___/         ${PKG.name} v${PKG.version}

${existing ? '✔ Existing config found — token kept' : '✔ Config written to ' + configPath()}
✔ Token: ${masked} (full: ramcp token show --full)
✔ Config: ${configPath()}

Next steps:
  1. ramcp start                    # run in foreground
  2. ramcp service install          # systemd + nginx (production)
  3. ramcp policy allow /srv/myapp  # let the AI touch your project
  4. ramcp url                      # connector URL for your chatbot
`);
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------
async function cmdStart(args: Args): Promise<void> {
  const cfg = loadConfig();
  if (args.values.has('host')) cfg.host = args.values.get('host')!;
  if (args.values.has('port')) cfg.port = parseInt(args.values.get('port')!, 10);
  if (!cfg.token) {
    console.error('No token. Run `ramcp init` first.');
    process.exit(1);
  }
  const { runServer } = await import('../server/run.js');
  await runServer();
}

// ---------------------------------------------------------------------------
// url
// ---------------------------------------------------------------------------
function cmdUrl(): void {
  const cfg = loadConfig();
  if (!cfg.token) { console.error('No token. Run `ramcp init` first.'); process.exit(1); }
  const host = cfg.public_host || `${cfg.host}:${cfg.port}`;
  const scheme = cfg.public_host ? 'https' : 'http';
  console.log(`${scheme}://${host}/${cfg.token}${cfg.mcp_path}`);
}

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------
function cmdToken(args: Args): void {
  const sub = args.sub[0];
  const cfg = loadConfig();
  if (sub === 'rotate') {
    const fresh = generateToken();
    cfg.token = fresh;
    saveConfig(cfg);
    console.log(`New token: ${fresh}`);
    console.log('Old token is dead. Update your chatbot connector now.');
    if (isSystemdInstalled()) {
      console.log('Restart the service to apply: systemctl restart remote-access-mcp');
    }
  } else if (sub === 'show') {
    if (!cfg.token) { console.error('No token. Run `ramcp init` first.'); process.exit(1); }
    if (args.flags.has('full')) console.log(cfg.token);
    else console.log(cfg.token.slice(0, 6) + '…' + cfg.token.slice(-4) + '  (use --full for the complete token)');
  } else {
    console.log('Usage: ramcp token <rotate|show [--full]>');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------
function cmdPolicy(args: Args): void {
  const cfg = loadConfig();
  const sub = args.sub[0] || '';

  if (sub === 'allow' && args.sub[1]) {
    const real = resolveReal(args.sub[1]);
    if (!cfg.allowed_paths.includes(real)) cfg.allowed_paths.push(real);
    saveConfig(cfg);
    console.log(`Allowed: ${real}`);
    reloadService();
  } else if (sub === 'deny' && args.sub[1]) {
    const real = resolveReal(args.sub[1]);
    cfg.allowed_paths = cfg.allowed_paths.filter((p: string) => p !== real);
    if (!cfg.denied_paths.includes(real)) cfg.denied_paths.push(real);
    saveConfig(cfg);
    console.log(`Denied: ${real}`);
    reloadService();
  } else if (sub === 'shell' && args.sub[1]) {
    const flag = args.sub[1].toLowerCase();
    if (flag !== 'on' && flag !== 'off') { console.error('Usage: ramcp policy shell on|off'); process.exit(1); }
    cfg.shell_enabled = flag === 'on';
    saveConfig(cfg);
    console.log(`Shell execution ${cfg.shell_enabled ? 'enabled' : 'disabled'}`);
    reloadService();
  } else {
    console.log(`allowed: ${cfg.allowed_paths.length ? '\n  ' + cfg.allowed_paths.join('\n  ') : '(none)'}`);
    console.log(`denied:  ${cfg.denied_paths.length ? '\n  ' + cfg.denied_paths.join('\n  ') : '(none)'}`);
    console.log(`shell:   ${cfg.shell_enabled ? 'enabled' : 'disabled'}`);
  }
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------
const SERVICE_NAME = 'remote-access-mcp';
const SERVICE_FILE = `/etc/systemd/system/${SERVICE_NAME}.service`;

function isSystemdInstalled(): boolean {
  return fs.existsSync(SERVICE_FILE);
}

function serviceRunning(): boolean {
  try {
    const out = fs.readFileSync(`/proc/self/cgroup`, 'utf8');
    return false; // placeholder, real check below via systemctl
  } catch { return false; }
}

function reloadService(): void {
  if (isSystemdInstalled()) {
    try {
      execFileSync('systemctl', ['restart', SERVICE_NAME], { stdio: 'ignore' });
      console.log('Service restarted to apply changes.');
    } catch {
      console.log('Note: service did not restart (not root?). Reboot or restart manually.');
    }
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
    console.log('Usage: ramcp service <install|uninstall|logs [-f]|status>');
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
  const pkgRoot = path.resolve(path.dirname(require.main?.filename || __filename), '..');

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
      console.log(`✔ nginx vhost installed: ${domain} → 127.0.0.1:${cfg.port}`);
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
  const { existsSync, readFileSync } = fs;
  if (existsSync(SERVICE_FILE)) {
    try { execFileSync('systemctl', ['disable', '--now', SERVICE_NAME]); } catch { /* not running */ }
    fs.unlinkSync(SERVICE_FILE);
    execFileSync('systemctl', ['daemon-reload']);
    console.log(`✔ systemd service removed`);
  } else {
    console.log('Service not installed.');
  }
  // remove any nginx vhost that points at us
  const sitesDir = '/etc/nginx/sites-enabled';
  if (existsSync(sitesDir)) {
    for (const f of fs.readdirSync(sitesDir)) {
      try {
        const content = readFileSync(path.join(sitesDir, f), 'utf8');
        if (content.includes(`proxy_pass http://127.0.0.1:${loadConfig().port}`)) {
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
    try {
      const out = execFileSync('systemctl', ['is-active', SERVICE_NAME], { encoding: 'utf8' }).trim();
      console.log(`service status:   ${out}`);
    } catch (e: any) {
      console.log(`service status:   ${e.stdout?.toString().trim() || 'unknown'}`);
    }
  }
  const cfg = loadConfig();
  console.log(`listen:           ${cfg.host}:${cfg.port}`);
  console.log(`token:            ${cfg.token ? cfg.token.slice(0, 6) + '…' : '(none — run ramcp init)'}`);
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
    case 'init': cmdInit(); break;
    case 'start': await cmdStart(args); break;
    case 'url': cmdUrl(); break;
    case 'token': cmdToken(args); break;
    case 'policy': cmdPolicy(args); break;
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
