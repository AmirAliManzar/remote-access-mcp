/**
 * Phase 0 baseline for the future Agent Engine.
 * Run `npm run build` first, then:
 *   NODE_ENV=test node scripts/benchmark-agent-baseline.mjs
 *
 * This measures only current per-request tool registration. It intentionally
 * does not execute host mutations, integrations, or real MCP client traffic.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from '../dist/tools/index.js';

const token = {
  id: 'benchmark', name: 'benchmark', token: 'benchmark-token',
  created: new Date().toISOString(), scopes: [], shell_enabled: false,
  allowed_paths: [], denied_paths: [],
};
const cfg = {
  host: '127.0.0.1', port: 8765, public_host: '', mcp_path: '/mcp',
  log_level: 'silent', audit: { enabled: false, db_path: '/tmp/unused' },
  read_only: false, tokens: [token],
};
const ctx = { cfg, token, readOnly: false, persist() {}, audit() {} };

process.env.NODE_ENV = 'test';
const samples = [];
let toolCount = 0;
for (let i = 0; i < 31; i++) {
  const server = new McpServer(
    { name: 'benchmark', version: '0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  const start = process.hrtime.bigint();
  await registerAllTools(server, ctx);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  if (i > 0) samples.push(elapsedMs);
  toolCount = Object.keys(server._registeredTools ?? {}).length;
}

const sorted = [...samples].sort((a, b) => a - b);
const percentile = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
console.log(JSON.stringify({
  iterations: samples.length,
  toolCount,
  registerMs: {
    min: sorted[0],
    p50: percentile(0.50),
    p95: percentile(0.95),
    max: sorted.at(-1),
    avg: average,
  },
  rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10,
}, null, 2));
