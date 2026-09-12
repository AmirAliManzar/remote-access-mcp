import blessed from 'blessed';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  loadConfig, saveConfig, generateToken, newTokenRecord,
  configPath, configDir, primaryToken, type RamcpConfig,
} from '../core/config.js';
import { resolveReal } from '../core/policy.js';
import { readRuntimeState } from '../core/platform.js';
import { startTunnelProvider, startTunnelAuto, type TunnelProviderName } from '../core/tunnel-providers.js';

const APP = 'Remote Access MCP';
const providers: Array<TunnelProviderName | 'auto'> = ['auto', 'pinggy', 'cloudflare', 'localhostrun'];

type Screen = blessed.Widgets.Screen;
type Box = blessed.Widgets.BoxElement;

const glyph = {
  ok: '●',
  off: '○',
  warn: '▲',
  arrow: '›',
};

function makeScreen(): Screen {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Remote Access MCP',
    fullUnicode: true,
    dockBorders: true,
    cursor: { artificial: true, blink: true, shape: 'line', color: 'cyan' },
  });
  screen.key(['q', 'C-c'], () => process.exit(0));
  return screen;
}

function header(screen: Screen, subtitle = 'Remote Access MCP'): Box {
  const box = blessed.box({
    parent: screen,
    top: 0, left: 0, right: 0, height: 3,
    tags: true,
    content: `{bold}{cyan-fg}${APP}{/cyan-fg}  {white-fg}${subtitle}{/white-fg}{/bold}`,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, fg: 'white' },
  });
  return box;
}

function footer(screen: Screen, text = '↑↓ Navigate   Enter Select   q Quit   Esc Back'): Box {
  return blessed.box({
    parent: screen,
    bottom: 0, left: 0, right: 0, height: 2,
    content: ` ${text}`,
    border: { type: 'line' },
    style: { border: { fg: 'gray' }, fg: 'gray' },
  });
}

function card(parent: Screen | Box, title: string, top: number, left: string | number, width: string | number, height: number): Box {
  return blessed.box({
    parent,
    top, left, width, height,
    label: ` ${title} `,
    tags: true,
    border: { type: 'line' },
    padding: { left: 1, right: 1 },
    style: { border: { fg: 'gray' }, label: { fg: 'cyan' }, fg: 'white' },
  });
}

function statusLine(label: string, state: 'ok' | 'warn' | 'off', value: string): string {
  const symbol = state === 'ok' ? `{green-fg}${glyph.ok}{/green-fg}` : state === 'warn' ? `{yellow-fg}${glyph.warn}{/yellow-fg}` : `{gray-fg}${glyph.off}{/gray-fg}`;
  return `${symbol} {bold}${label.padEnd(15)}{/bold} ${value}`;
}

function dashboard(screen: Screen): void {
  screen.children.slice(0).forEach(c => c !== screen && c.destroy());
  header(screen, 'Remote Access MCP');
  const cfg = loadConfig();
  const rt = readRuntimeState();
  const running = !!rt;
  const tunnel = !!rt?.tunnel_url;
  const direct = !!rt?.direct_url;

  const overview = card(screen, 'STATUS', 4, 1, '48%', 11);
  overview.setContent([
    '',
    statusLine('MCP Server', running ? 'ok' : 'off', running ? `Running · PID ${rt!.pid}` : 'Stopped'),
    statusLine('Connection', running ? 'ok' : 'off', running ? 'Ready' : 'Offline'),
    statusLine('Tunnel', tunnel ? 'ok' : direct ? 'ok' : 'off', tunnel ? 'Connected' : direct ? 'Direct HTTP' : 'Not connected'),
    statusLine('Authentication', cfg.tokens.length ? 'ok' : 'warn', cfg.tokens.length ? `${cfg.tokens.length} token(s)` : 'No tokens'),
    statusLine('Audit', cfg.audit.enabled ? 'ok' : 'warn', cfg.audit.enabled ? 'Enabled' : 'Disabled'),
    '',
    `{gray-fg}${cfg.host}:${cfg.port}${cfg.mcp_path}{/gray-fg}`,
  ].join('\n'));

  const publicBox = card(screen, 'PUBLIC ENDPOINT', 4, '51%', '48%', 11);
  const publicUrl = rt?.tunnel_url || rt?.direct_url || (cfg.public_host ? `https://${cfg.public_host}${cfg.mcp_path}` : '—');
  const endpointState = rt?.tunnel_url || rt?.direct_url ? 'Live runtime endpoint' : cfg.public_host ? 'Configured endpoint · server currently stopped' : 'No public endpoint configured';
  publicBox.setContent(`\n {bold}{cyan-fg}${publicUrl}{/cyan-fg}{/bold}\n\n {gray-fg}${endpointState}{/gray-fg}`);

  const menu = blessed.list({
    parent: screen, top: 16, left: 1, width: '98%', height: 10,
    label: ' MENU ', border: { type: 'line' },
    keys: true, vi: false, mouse: false,
    items: [
      'Server',
      'Connection',
      'Access',
      'System',
      'Setup',
      'Quit',
    ],
    style: {
      border: { fg: 'gray' }, selected: { bg: 'cyan', fg: 'black', bold: true },
      item: { fg: 'white', bold: false },
    },
    tags: true,
  });
  footer(screen);
  screen.append(menu);
  menu.focus();
  menu.on('select', (_item, index) => {
    if (index === 0) serverMenu(screen);
    else if (index === 1) tunnelMenu(screen);
    else if (index === 2) tokenMenu(screen);
    else if (index === 3) systemMenu(screen);
    else if (index === 4) wizard(screen);
    else process.exit(0);
  });
  screen.render();
}

function runCommand(screen: Screen, args: string[]): void {
  const box = card(screen, 'OPERATION', 4, 2, '96%', 18);
  footer(screen, 'Running…   q Quit');
  const bin = process.argv[1];
  const child = spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let output = '';
  const append = (data: Buffer) => {
    output += data.toString();
    box.setContent(`\n${output.slice(-12000)}`);
    screen.render();
  };
  child.stdout.on('data', append); child.stderr.on('data', append);
  child.on('close', code => {
    box.setContent(`\n${output.slice(-11000)}\n\n{${code === 0 ? 'green-fg' : 'red-fg'}}${code === 0 ? '✓ Completed' : `✗ Failed (exit ${code})`}{/}\n\nPress Enter to return.`);
    footer(screen, 'Enter Back   q Quit');
    screen.onceKey('enter', () => dashboard(screen));
    screen.render();
  });
  screen.render();
}

function sectionMenu(screen: Screen, title: string, items: string[], actions: Array<() => void>): void {
  screen.children.slice(0).forEach(c => c !== screen && c.destroy());
  header(screen, title);
  const list = blessed.list({
    parent: screen, top: 5, left: 3, width: '94%', height: Math.min(items.length + 4, 16),
    label: ` ${title.toUpperCase()} `, border: { type: 'line' }, keys: true, tags: true,
    items,
    style: { border: { fg: 'gray' }, selected: { bg: 'cyan', fg: 'black', bold: true }, item: { fg: 'white' } },
  });
  footer(screen); screen.append(list); list.focus(); screen.render();
  list.on('select', (_item, index) => actions[index]?.());
}

function serverMenu(screen: Screen): void {
  sectionMenu(screen, 'Server', ['Start / Restart MCP', 'Stop MCP', 'Refresh Dashboard', 'Back'], [
    () => runCommand(screen, ['start']),
    () => runCommand(screen, ['service', 'stop']),
    () => dashboard(screen),
    () => dashboard(screen),
  ]);
}

function systemMenu(screen: Screen): void {
  sectionMenu(screen, 'System', ['Diagnostics', 'Logs', 'Back'], [
    () => diagnostics(screen),
    () => logs(screen),
    () => dashboard(screen),
  ]);
}

function tunnelMenu(screen: Screen): void {
  screen.children.slice(0).forEach(c => c !== screen && c.destroy());
  header(screen, 'Tunnel & Connection');
  const list = blessed.list({
    parent: screen, top: 5, left: 3, width: '94%', height: 12,
    label: ' PROVIDER ', border: { type: 'line' }, keys: true,
    items: ['Auto-select', 'Pinggy', 'Cloudflare', 'localhost.run', 'Direct HTTP', 'Back'],
    style: { border: { fg: 'gray' }, selected: { bg: 'cyan', fg: 'black', bold: true } },
  });
  footer(screen);
  screen.append(list); list.focus(); screen.render();
  list.on('select', (_item, index) => {
    if (index === 5) dashboard(screen);
    else if (index === 4) runCommand(screen, ['tunnel', '--direct']);
    else runCommand(screen, ['tunnel', '--provider', providers[index]]);
  });
}

function input(screen: Screen, title: string, value: string, done: (value: string) => void): void {
  const box = card(screen, title, 7, 8, '84%', 7);
  box.setContent('\n  Enter value:');
  const text = blessed.textbox({ parent: box, top: 2, left: 2, right: 2, height: 3,
    inputOnFocus: true, value, keys: true, border: { type: 'line' }, style: { border: { fg: 'cyan' }, focus: { border: { fg: 'green' } } } });
  footer(screen, 'Enter Confirm   Esc Cancel');
  text.focus(); screen.render();
  text.on('submit', (v: string) => done(v.trim()));
  text.on('cancel', () => dashboard(screen));
}

function wizard(screen: Screen): void {
  screen.children.slice(0).forEach(c => c !== screen && c.destroy());
  header(screen, 'First-time Setup Wizard');
  const cfgExists = fs.existsSync(configPath());
  if (cfgExists) {
    const cfg = loadConfig();
    const box = card(screen, 'SETUP', 5, 3, '94%', 13);
    box.setContent(`\n {bold}Remote Access MCP is already configured.{/bold}\n\n Config: {cyan-fg}${configPath()}{/cyan-fg}\n Tokens: ${cfg.tokens.length}\n Endpoint: ${cfg.host}:${cfg.port}${cfg.mcp_path}\n\n Re-run setup and keep the existing token?`);
    const list = blessed.list({ parent: box, top: 8, left: 2, width: '96%', height: 4, keys: true, items: ['Continue setup', 'Back'], style: { selected: { bg: 'cyan', fg: 'black', bold: true } } });
    screen.append(list); list.focus(); footer(screen); screen.render();
    list.once('select', (_x, i) => i === 0 ? setupPaths(screen, cfg) : dashboard(screen));
    return;
  }
  const fresh: RamcpConfig = {
    host: '127.0.0.1', port: 8765, public_host: '', mcp_path: '/mcp', log_level: 'info',
    audit: { enabled: true, db_path: path.join(configDir(), 'audit.jsonl') }, read_only: false, tokens: [],
  };
  setupPaths(screen, fresh);
}

function setupPaths(screen: Screen, cfg: RamcpConfig): void {
  screen.children.slice(0).forEach(c => c !== screen && c.destroy());
  header(screen, 'Setup · Access');
  const info = card(screen, 'ACCESS', 5, 3, '94%', 8);
  info.setContent('\n Choose the first directory the MCP token can access.\n Leave empty to finish with no filesystem access.');
  input(screen, 'Allowed Directory', '', value => {
    if (value) {
      const p = resolveReal(value);
      if (!cfg.tokens.length) cfg.tokens.push(newTokenRecord({ name: 'default', allowed_paths: [p] }));
      else if (!cfg.tokens[0].allowed_paths.includes(p)) cfg.tokens[0].allowed_paths.push(p);
    }
    if (!cfg.tokens.length) cfg.tokens.push(newTokenRecord({ name: 'default', allowed_paths: [] }));
    saveConfig(cfg);
    setupTunnel(screen);
  });
}

function setupTunnel(screen: Screen): void {
  screen.children.slice(0).forEach(c => c !== screen && c.destroy());
  header(screen, 'Setup · Connection');
  const list = blessed.list({ parent: screen, top: 6, left: 4, width: '92%', height: 11,
    label: ' How should the gateway connect? ', border: { type: 'line' }, keys: true,
    items: ['Local only', 'Auto-select public tunnel', 'Pinggy', 'Cloudflare', 'localhost.run'],
    style: { border: { fg: 'gray' }, selected: { bg: 'cyan', fg: 'black', bold: true } } });
  footer(screen); screen.append(list); list.focus(); screen.render();
  list.once('select', (_x, index) => {
    if (index === 0) finishWizard(screen, false);
    else finishWizard(screen, true, index === 1 ? 'auto' : providers[index - 1]);
  });
}

function finishWizard(screen: Screen, tunnel: boolean, provider?: TunnelProviderName | 'auto'): void {
  screen.children.slice(0).forEach(c => c !== screen && c.destroy());
  header(screen, 'Setup · Complete');
  const box = card(screen, 'READY', 5, 3, '94%', 13);
  box.setContent('\n {bold}{green-fg}✓ Remote Access MCP configuration saved{/green-fg}{/bold}\n\n Start the MCP server now?');
  const list = blessed.list({ parent: box, top: 6, left: 2, width: '96%', height: 5, keys: true,
    items: ['Start now', 'Open dashboard', 'Exit'], style: { selected: { bg: 'cyan', fg: 'black', bold: true } } });
  screen.append(list); list.focus(); footer(screen); screen.render();
  list.once('select', (_x, index) => {
    if (index === 0) runCommand(screen, tunnel ? ['start', '--tunnel', '--provider', provider!] : ['start']);
    else if (index === 1) dashboard(screen);
    else process.exit(0);
  });
}

function tokenMenu(screen: Screen): void {
  screen.children.slice(0).forEach(c => c !== screen && c.destroy());
  header(screen, 'Tokens & Access');
  const cfg = loadConfig();
  const box = card(screen, 'TOKENS', 4, 2, '96%', 17);
  const lines = cfg.tokens.map(t => ` {green-fg}${glyph.ok}{/green-fg} {bold}${t.name}{/bold}  ${t.id}  paths:${t.allowed_paths.length}  shell:${t.shell_enabled ? 'on' : 'off'}`);
  box.setContent(`\n${lines.join('\n')}\n\n {gray-fg}Tokens are intentionally masked here. Use the CLI for full token operations.{/gray-fg}`);
  const list = blessed.list({ parent: screen, top: 22, left: 2, width: '96%', height: 4, keys: true, items: ['Generate new token', 'Back'], style: { selected: { bg: 'cyan', fg: 'black', bold: true } } });
  screen.append(list); list.focus(); footer(screen); screen.render();
  list.on('select', (_x, i) => {
    if (i === 1) dashboard(screen);
    else {
      const rec = newTokenRecord({ name: `token-${cfg.tokens.length + 1}`, allowed_paths: [] });
      cfg.tokens.push(rec); saveConfig(cfg);
      box.setContent(`\n {green-fg}✓ New token created{/green-fg}\n\n Name: ${rec.name}\n Token: {bold}${rec.token}{/bold}\n\n Store it securely — it will not be shown again here.`);
      screen.render();
    }
  });
}

function diagnostics(screen: Screen): void {
  screen.children.slice(0).forEach(c => c !== screen && c.destroy());
  header(screen, 'Diagnostics');
  const cfg = loadConfig(); const rt = readRuntimeState();
  const box = card(screen, 'HEALTH CHECK', 4, 2, '96%', 19);
  const diagnosticLines = [
    statusLine('Configuration', 'ok', configPath()),
    statusLine('MCP Server', rt ? 'ok' : 'warn', rt ? `Running · ${rt.pid}` : 'Not running'),
    statusLine('Authentication', cfg.tokens.length ? 'ok' : 'warn', `${cfg.tokens.length} token(s)`),
    statusLine('Audit logging', cfg.audit.enabled ? 'ok' : 'warn', cfg.audit.enabled ? 'Enabled' : 'Disabled'),
    statusLine('Filesystem', cfg.tokens.some(t => t.allowed_paths.length) ? 'ok' : 'warn', `${cfg.tokens.reduce((n,t) => n+t.allowed_paths.length,0)} allowed path(s)`),
    statusLine('Tunnel', rt?.tunnel_url ? 'ok' : 'off', rt?.tunnel_url || 'Not connected'),
  ];
  box.setContent(`\n ${diagnosticLines.join('\n ')}\n\n {gray-fg}For provider-level diagnostics use \`ramcp doctor\` from the shell.{/gray-fg}`);
  footer(screen, 'Enter Back   q Quit'); screen.key('enter', () => dashboard(screen)); screen.render();
}

function logs(screen: Screen): void {
  screen.children.slice(0).forEach(c => c !== screen && c.destroy());
  header(screen, 'Logs');
  const box = card(screen, 'RECENT OUTPUT', 4, 2, '96%', 19);
  box.setContent('\n {gray-fg}Use `ramcp service logs -f` for the live service journal.\n\nThe TUI deliberately does not stream a second copy of the service here.{/gray-fg}');
  footer(screen, 'Enter Back   q Quit'); screen.key('enter', () => dashboard(screen)); screen.render();
}

export function launchTui(): void {
  const screen = makeScreen();
  if (!fs.existsSync(configPath())) wizard(screen);
  else dashboard(screen);
}
