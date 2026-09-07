import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RamcpConfig, TokenRecord } from '../core/config.js';

interface Manifest {
  name: string;
  version: string;
  description?: string;
  entry: string;
  permissions?: string[];
  scopes?: string[];
}

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const pluginDir = path.resolve(arg('--plugin-dir'));
  const entry = path.resolve(arg('--entry'));
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;

  const rel = path.relative(pluginDir, entry);
  if (!rel || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error('Plugin entry escapes plugin directory');
  }

  const server = new McpServer({ name: `ramcp-plugin:${manifest.name}`, version: manifest.version });
  const token: TokenRecord = {
    id: `plugin:${manifest.name}`,
    name: manifest.name,
    token: '',
    created: new Date().toISOString(),
    scopes: manifest.scopes || [],
    shell_enabled: false,
    allowed_paths: [pluginDir],
    denied_paths: [],
    read_only: true,
  };
  const cfg = {} as RamcpConfig;
  const ctx = {
    cfg,
    token,
    readOnly: true,
    persist: () => {},
    audit: () => {},
  };

  const mod = await import(pathToFileURL(entry).href);
  if (typeof mod.register !== 'function') throw new Error('Plugin entry must export register(server, ctx)');
  await mod.register(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`ramcp plugin host: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

export const PLUGIN_HOST_ENTRY = fileURLToPath(import.meta.url);
