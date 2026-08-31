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
import { startQuickTunnel, type TunnelHandle } from '../core/tunnel.js';

const exec = promisify(execFile);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

export async function runServer(opts: {
  host?: string;
  port?: number;
  readOnly?: boolean;
  tunnel?: boolean;
} = {}): Promise<void> {
  const cfg = loadLiveConfig();
  if (!cfg.tokens.length) {
    console.error('No tokens configured. Run `ramcp init` first.');
    process.exit(1);
  }
  const host = opts.host || cfg.host;
  const port = opts.port || cfg.port;
  if (opts.readOnly) cfg.read_only = true;

  const { app } = buildApp();

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

  const httpServer = createServer(app);
  let tunnel: TunnelHandle | null = null;

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
  if (wantTunnel) {
    try {
      tunnel = await startQuickTunnel({ port, host, log: (m) => console.log(`[tunnel] ${m}`) });
      writeRuntimeState({ pid: process.pid, tunnel_url: tunnel.url, host, port, started: new Date().toISOString() });
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
      console.error(`[tunnel] failed: ${e.message}`);
      console.error('[tunnel] the gateway is still reachable locally.');
    }
  } else if (cfg.public_host) {
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
    tunnel?.stop();
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
