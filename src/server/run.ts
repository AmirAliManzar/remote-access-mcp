import { createServer } from 'node:http';
import { loadConfig, requireToken } from '../core/config.js';
import { buildApp } from './app.js';

export async function runServer(): Promise<void> {
  const cfg = loadConfig();
  requireToken(cfg);

  const { app } = buildApp();
  const httpServer = createServer(app);

  httpServer.listen(cfg.port, cfg.host, () => {
    const publicUrl = cfg.public_host
      ? `https://${cfg.public_host}${cfg.mcp_path}`
      : `http://${cfg.host}:${cfg.port}${cfg.mcp_path}`;
    console.log(`remote-access-mcp listening on ${cfg.host}:${cfg.port}`);
    console.log(`endpoint:  ${publicUrl}`);
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
