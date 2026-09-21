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
import { startTunnelProvider, startTunnelAuto, verifyTunnelHealth, TUNNEL_PROVIDERS, type TunnelProviderName } from '../core/tunnel-providers.js';
import { jobManager } from '../core/jobs.js';
import { allowDirectPort, chooseDirectPort, denyDirectPort, getPublicIPv4 } from '../core/direct-http.js';
import { AuditLog } from '../core/audit.js';
import { startAutomationEngine } from '../core/automation-engine.js';

const exec = promisify(execFile);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

export function getTunnelRecoveryOrder(failedProvider?: TunnelProviderName, preferred?: TunnelProviderName): TunnelProviderName[] {
  if (!failedProvider) {
    return preferred
      ? [preferred, ...TUNNEL_PROVIDERS.filter((p) => p !== preferred)]
      : [...TUNNEL_PROVIDERS];
  }
  if (!TUNNEL_PROVIDERS.includes(failedProvider)) return [...TUNNEL_PROVIDERS];
  const baseOrder = preferred
    ? [preferred, ...TUNNEL_PROVIDERS.filter((provider) => provider !== preferred)]
    : [...TUNNEL_PROVIDERS];
  return [
    ...baseOrder.filter((provider) => provider !== failedProvider),
    failedProvider,
  ];
}

export async function runServer(opts: {
  host?: string;
  port?: number;
  readOnly?: boolean;
  tunnel?: boolean;
  tunnelProvider?: TunnelProviderName | 'auto';
  direct?: boolean;
  directPort?: number;
  debug?: boolean;
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
        ? await startTunnelAuto({ port, host, expectedVersion: PKG.version, debug: opts.debug, log: (m) => console.log(`[tunnel] ${m}`) }, preferred)
        : await startTunnelProvider(provider as TunnelProviderName, { port, host, expectedVersion: PKG.version, debug: opts.debug, log: (m) => console.log(`[tunnel] ${m}`) });
      cfg.tunnel = { ...(cfg.tunnel || { provider: configured as any, auto_start: false }), preferred_provider: tunnel.provider as any, last_url: tunnel.url };
      try { const { saveConfig } = await import('../core/config.js'); saveConfig(cfg); } catch { /* runtime link persistence is best effort */ }
      writeRuntimeState({ pid: process.pid, tunnel_url: tunnel.url, tunnel_provider: tunnel.provider, host, port, started: new Date().toISOString() });
      console.log(`\npublic URL: ${tunnel.url}${cfg.mcp_path}`);
      console.log(`connector:  ${tunnel.url}/${cfg.tokens[0].token}${cfg.mcp_path}`);

      console.log(`[tunnel] verified: public endpoint reaches Remote Access MCP v${PKG.version}.`);

      console.log(`\n(tunnel health is monitored; keep this process running — the URL dies when it exits)`);
    } catch (e: any) {
      tunnelFailed = true;
      console.error(`[tunnel] failed: ${e.message}`);
      console.error('[tunnel] the gateway is still reachable locally.');
      if (wantDirect) {
        console.log('[direct] explicitly requested; starting direct HTTP.');
      } else {
        console.error('[direct] not started: direct HTTP is not an automatic tunnel fallback.');
        console.error('[direct] on laptops behind NAT, use a working tunnel provider or run `ramcp tunnel --direct` only when inbound access is available.');
      }
    }
  }

  let shuttingDown = false;
  let tunnelMonitor: NodeJS.Timeout | undefined;
  let tunnelRecovering = false;
  let monitoredProvider: TunnelProviderName | undefined = tunnel?.provider as TunnelProviderName | undefined;
  if (tunnel) {
    let consecutiveFailures = 0;
    // Providers can report a URL and then lose the reverse session moments
    // later. Detect both process death and public health failure quickly.
    tunnelMonitor = setInterval(async () => {
      if (tunnelRecovering || shuttingDown) return;
      let health: Awaited<ReturnType<typeof verifyTunnelHealth>> | null = null;
      if (tunnel) {
        if (tunnel.child.exitCode !== null || tunnel.child.killed) {
          consecutiveFailures = 2;
          console.error(`[tunnel] provider process exited (${tunnel.provider})`);
        } else {
          health = await verifyTunnelHealth(tunnel.url, PKG.version, 5000);
          if (health.healthy) {
            consecutiveFailures = 0;
            return;
          }
          consecutiveFailures += 1;
          if (consecutiveFailures < 2) return;
          console.error(`[tunnel] unhealthy (${tunnel.provider}): ${health.reason || 'unknown error'}`);
        }
      } else {
        consecutiveFailures = 2;
      }

      // set the recovery lock before any await so the 3s monitor interval
      // cannot start a second recovery while this one is waiting for the
      // localhost.run supervisor or another provider.
      tunnelRecovering = true;

      if (tunnel?.provider === 'localhostrun' && process.platform === 'win32') {
        const reconnectUrl = tunnel.url;
        console.log('[tunnel] localhostrun supervisor reconnect detected; waiting before provider failover...');
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        if (tunnel && tunnel.url !== reconnectUrl) {
          const reconnectedHealth = await verifyTunnelHealth(tunnel.url, PKG.version, 5_000);
          if (reconnectedHealth.healthy) {
            console.log(`[tunnel] localhostrun supervisor recovered: ${tunnel.url}`);
            consecutiveFailures = 0;
            tunnelRecovering = false;
            return;
          }
        } else if (tunnel) {
          const retryHealth = await verifyTunnelHealth(tunnel.url, PKG.version, 5_000);
          if (retryHealth.healthy) {
            consecutiveFailures = 0;
            tunnelRecovering = false;
            return;
          }
        }
      }

      const failedTunnel = tunnel;
      const failedProvider = (failedTunnel?.provider as TunnelProviderName | undefined) || monitoredProvider || cfg.tunnel?.preferred_provider as TunnelProviderName;
      if (!failedProvider) { tunnelRecovering = false; return; }
      console.log('[tunnel] attempting automatic recovery...');
      try { failedTunnel?.stop(); } catch {}
      tunnel = null;

      // Rotate away from the failed provider first. Do not let a preferred
      // provider pin Auto recovery to the same broken service.
      // Example: localhostrun fails -> pinggy -> nport -> cloudflare -> localhostrun.
      // Only retry the failed provider after every alternative was attempted.
      const preferred = cfg.tunnel?.preferred_provider as TunnelProviderName | undefined;
      const order = getTunnelRecoveryOrder(failedProvider, preferred);
      console.log(`[tunnel] recovery order: ${order.join(' → ')}`);
      let recovered: TunnelHandle | null = null;
      const failures: string[] = [];
      for (const provider of order) {
        try {
          console.log(`[tunnel] reconnect: trying ${provider}...`);
          const candidate = await startTunnelProvider(provider, { port, host, expectedVersion: PKG.version, debug: opts.debug, log: (m) => console.log(`[tunnel] ${m}`) });
          const candidateHealth = await verifyTunnelHealth(candidate.url, PKG.version, 8000);
          if (!candidateHealth.healthy) {
            failures.push(`${provider}: ${candidateHealth.reason || 'health check failed'}`);
            try { candidate.stop(); } catch {}
            continue;
          }
          recovered = candidate;
          break;
        } catch (e: any) {
          const reason = e?.message || String(e);
          failures.push(`${provider}: ${reason}`);
          console.error(`[tunnel] ${provider} failed: ${reason}`);
        }
      }
      if (recovered) {
        tunnel = recovered;
        monitoredProvider = recovered.provider as TunnelProviderName;
        cfg.tunnel = { ...(cfg.tunnel || { provider: recovered.provider as any, auto_start: false }), preferred_provider: recovered.provider as any, last_url: recovered.url };
        try { const { saveConfig } = await import('../core/config.js'); saveConfig(cfg); } catch {}
        writeRuntimeState({ pid: process.pid, tunnel_url: recovered.url, tunnel_provider: recovered.provider, host, port, started: new Date().toISOString() });
        console.log(`[tunnel] recovered: ${recovered.provider} → ${recovered.url}${cfg.mcp_path}`);
        consecutiveFailures = 0;
      } else {
        console.error(`[tunnel] recovery failed: ${failures.join(' | ')}`);
        tunnelFailed = true;
      }
      tunnelRecovering = false;
    }, 3_000);
    tunnelMonitor.unref();
  }

  if (wantDirect) {
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

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nshutting down...');
    jobManager.shutdown();
    if (tunnelMonitor) clearInterval(tunnelMonitor);
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
