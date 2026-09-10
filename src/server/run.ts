import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLiveConfig } from '../core/config.js';
import { buildApp } from './app.js';
import { startScheduler } from '../tools/schedule.js';
import { shellCommand, childEnv, platformLabel, writeRuntimeState, clearRuntimeState, dataDir } from '../core/platform.js';
import { type TunnelHandle } from '../core/tunnel.js';
import { startTunnelProvider, startTunnelAuto, type TunnelProviderName } from '../core/tunnel-providers.js';
import { jobManager } from '../core/jobs.js';
import { allowDirectPort, chooseDirectPort, denyDirectPort, getPublicIPv4 } from '../core/direct-http.js';
import { AuditLog } from '../core/audit.js';
import { startAutomationEngine } from '../core/automation-engine.js';

const exec = promisify(execFile);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

export async function runServer(opts: {
  host?: string;
  port?: number;
  readOnly?: boolean;
  tunnel?: boolean;
  tunnelProvider?: TunnelProviderName | 'auto';
  direct?: boolean;
  directPort?: number;
} = {}): Promise<void> {
  const cfg = loadLiveConfig();
  if (!cfg.tokens.length) {
    console.error('No tokens configured. Run `ramcp init` first.');
    process.exit(1);
  }
  const host = opts.host || cfg.host;
  const port = opts.port || cfg.port;
  if (opts.readOnly) cfg.read_only = true;

  const { app, state } = buildApp();

  // Scheduled-task ticker: runs commands with the platform's shell.
  const scheduler = startScheduler(async (task) => {
    console.log(`[scheduler] ${task.id}: ${task.command}`);
    const { file, args } = shellCommand(task.command);
    try {
      await exec(file, args, { timeout: 300_000, env: childEnv(), windowsHide: true });
    } catch (e: any) {
      console.error(`[scheduler] ${task.id} failed:`, e.message);
    }
  });
  scheduler.unref();

  const automation = startAutomationEngine(async (rule, action) => {
    console.log(`[automation] ${rule.id}: ${action.tool}`);
    const owner = cfg.tokens.find(t => AuditLog.fingerprint(t.token) === rule.tokenFingerprint);
    if (!owner) throw new Error('Automation owner token no longer exists');
    if (cfg.read_only || owner.read_only) throw new Error('Automation blocked by read-only policy');
    if (!state.automationInvoke) throw new Error('Automation executor is unavailable');
    await state.automationInvoke(owner, action.tool, action.args, 1);
  }, cfg);
  automation.unref();

  const httpServer = createServer(app);
  let directServer: ReturnType<typeof createServer> | null = null;
  let directPort: number | undefined;
  let tunnel: TunnelHandle | null = null;
  let tunnelFailed = false;

  await new Promise<void>((resolve) => httpServer.listen(port, host, () => resolve()));

  // Live state for `ramcp url` / `ramcp doctor` in other terminals.
  // The tunnel URL is only valid while THIS process runs, so it goes to
  // runtime.json (ephemeral, pid-checked) — never into config.json, where
  // it would clobber a server's real public_host the moment someone ran
  // `ramcp tunnel` on it.
  writeRuntimeState({ pid: process.pid, host, port, started: new Date().toISOString() });

  console.log(`remote-access-mcp v${PKG.version} on ${platformLabel()}`);
  console.log(`listening:  ${host}:${port}`);
  console.log(`tokens:     ${cfg.tokens.length} | audit: ${cfg.audit.enabled ? 'on' : 'off'} | read_only: ${cfg.read_only ? 'on' : 'off'}`);

  const wantTunnel = opts.tunnel ?? cfg.tunnel?.auto_start ?? false;
  const wantDirect = opts.direct === true || cfg.direct_http?.enabled === true;
  if (wantTunnel) {
    try {
      const preferred = cfg.tunnel?.preferred_provider;
      const configured = opts.tunnelProvider || cfg.tunnel?.provider || 'cloudflare';
      const provider = configured === 'auto' && preferred ? preferred : configured;
      console.log(`[tunnel] provider: ${provider}${configured === 'auto' && preferred ? ' (preferred)' : ''}`);
      tunnel = configured === 'auto'
        ? await startTunnelAuto({ port, host, log: (m) => console.log(`[tunnel] ${m}`) }, preferred)
        : await startTunnelProvider(provider as TunnelProviderName, { port, host, log: (m) => console.log(`[tunnel] ${m}`) });
      cfg.tunnel = { ...(cfg.tunnel || { provider: configured as any, auto_start: false }), preferred_provider: tunnel.provider as any, last_url: tunnel.url };
      try { const { saveConfig } = await import('../core/config.js'); saveConfig(cfg); } catch { /* runtime link persistence is best effort */ }
      writeRuntimeState({ pid: process.pid, tunnel_url: tunnel.url, tunnel_provider: tunnel.provider, host, port, started: new Date().toISOString() });
      console.log(`\npublic URL: ${tunnel.url}${cfg.mcp_path}`);
      console.log(`connector:  ${tunnel.url}/${cfg.tokens[0].token}${cfg.mcp_path}`);

      // Verify the public URL actually answers. Quick tunnels are best-effort:
      // on a few networks (some datacenters, filtered ISPs) the edge accepts
      // the connection but never proxies traffic. Telling the user now beats
      // them pasting a dead URL into a chatbot later.
      try {
        const deadline = Date.now() + 20_000;
        let healthy = false;
        while (Date.now() < deadline && !healthy) {
          try {
            const r = await fetch(`${tunnel.url}/health`, { signal: AbortSignal.timeout(5000) });
            healthy = r.ok;
          } catch { /* DNS/edge propagation — retry */ }
          if (!healthy) await new Promise((r) => setTimeout(r, 3000));
        }
        if (healthy) {
          console.log(`[tunnel] verified: the public URL answers from the internet.`);
        } else {
          console.log(`[tunnel] WARNING: could not reach ${tunnel.url} from here.`);
          console.log(`[tunnel] Some networks (filtered ISPs, certain datacenters) block the`);
          console.log(`[tunnel] tunnel data path. Try a different network, or host the gateway`);
          console.log(`[tunnel] on a server with a real domain instead.`);
        }
      } catch { /* verification is advisory only */ }

      console.log(`\n(keep this process running — the URL dies when it exits)`);
    } catch (e: any) {
      tunnelFailed = true;
      console.error(`[tunnel] failed: ${e.message}`);
      console.error('[tunnel] the gateway is still reachable locally.');
      console.log('[direct] tunnel unavailable; trying direct HTTP fallback.');
    }
  }

  if (wantDirect || (!tunnel && tunnelFailed)) {
    try {
      directPort = await chooseDirectPort(opts.directPort ?? cfg.direct_http?.port);
      directServer = createServer(app);
      await new Promise<void>((resolve, reject) => {
        directServer!.once('error', reject);
        directServer!.listen(directPort!, '0.0.0.0', () => { directServer!.removeListener('error', reject); resolve(); });
      });
      await allowDirectPort(directPort);
      cfg.direct_http = { enabled: false, port: directPort };
      try { const { saveConfig } = await import('../core/config.js'); saveConfig(cfg); } catch { /* best effort */ }
      const ipv4 = getPublicIPv4();
      const directUrl = ipv4 ? `http://${ipv4}:${directPort}` : `http://<server-ipv4>:${directPort}`;
      writeRuntimeState({ pid: process.pid, tunnel_url: tunnel?.url, tunnel_provider: tunnel?.provider, direct_url: directUrl, direct_port: directPort, host, port, started: new Date().toISOString() });
      console.log(`\npublic direct URL: ${directUrl}${cfg.mcp_path}`);
      console.log(`direct connector:  ${directUrl}/${cfg.tokens[0].token}${cfg.mcp_path}`);
      try {
        const r = await fetch(`http://127.0.0.1:${directPort}/health`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        console.log('[direct] verified: local listener and MCP gateway are healthy.');
      } catch (e: any) {
        console.log(`[direct] WARNING: health check failed: ${e.message}`);
      }
    } catch (e: any) {
      if (directServer) { try { directServer.close(); } catch {} directServer = null; }
      console.error(`[direct] failed: ${e.message}`);
    }
  } else if (!tunnel && cfg.public_host) {
    console.log(`endpoint:   https://${cfg.public_host}${cfg.mcp_path}`);
  } else {
    console.log(`endpoint:   http://${host}:${port}${cfg.mcp_path}`);
    console.log(`tip: no public IP? run \`ramcp tunnel\` for an instant https URL.`);
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nshutting down...');
    jobManager.shutdown();
    tunnel?.stop();
    if (directPort) void denyDirectPort(directPort);
    directServer?.close();
    clearRuntimeState();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Windows services (schtasks) stop without POSIX signals.
  process.on('exit', () => clearRuntimeState());
}

// Direct execution: `node dist/server/run.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  runServer({ tunnel: process.argv.includes('--tunnel') }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
