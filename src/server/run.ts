import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadLiveConfig } from '../core/config.js';
import { buildApp } from './app.js';
import { startScheduler } from '../tools/schedule.js';

const exec = promisify(execFile);

export async function runServer(opts: { host?: string; port?: number; readOnly?: boolean } = {}): Promise<void> {
  const cfg = loadLiveConfig();
  if (!cfg.tokens.length) {
    console.error('No tokens configured. Run `ramcp init` first.');
    process.exit(1);
  }
  const host = opts.host || cfg.host;
  const port = opts.port || cfg.port;
  if (opts.readOnly) cfg.read_only = true;

  const { app, state } = buildApp();

  // Scheduled-task ticker: runs shell commands when their time comes.
  const scheduler = startScheduler(async (task) => {
    console.log(`[scheduler] ${task.id}: ${task.command}`);
    try {
      await exec('bash', ['-lc', task.command], { timeout: 300_000 });
    } catch (e: any) {
      console.error(`[scheduler] ${task.id} failed:`, e.message);
    }
  });
  scheduler.unref();

  const httpServer = createServer(app);
  httpServer.listen(port, host, () => {
    const publicUrl = cfg.public_host
      ? `https://${cfg.public_host}${cfg.mcp_path}`
      : `http://${host}:${port}${cfg.mcp_path}`;
    console.log(`remote-access-mcp v${state.cfg === cfg ? '2.0' : '2.0'} listening on ${host}:${port}`);
    console.log(`endpoint:  ${publicUrl}`);
    console.log(`tokens:    ${cfg.tokens.length} | audit: ${cfg.audit.enabled ? 'on' : 'off'} | read_only: ${cfg.read_only ? 'on' : 'off'}`);
    console.log(`stateless MCP over streamable HTTP — token auth required`);
  });

  const shutdown = () => {
    console.log('\nshutting down...');
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Direct execution: `node dist/server/run.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  runServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
