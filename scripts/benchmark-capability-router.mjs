process.env.NODE_ENV = 'test';
import http from 'node:http';
import { buildApp, createGatewayState } from '../dist/server/app.js';

async function run(scoped) {
  const previous = process.env.RAMCP_TOOL_EXPOSURE;
  if (scoped) process.env.RAMCP_TOOL_EXPOSURE = 'scoped'; else delete process.env.RAMCP_TOOL_EXPOSURE;
  const state = createGatewayState();
  state.cfg = {
    host: '127.0.0.1', port: 0, public_host: '', mcp_path: '/mcp', log_level: 'silent',
    audit: { enabled: false, db_path: '/dev/null' }, read_only: false,
    tokens: [{ id: 'bench', name: 'bench', token: 'benchmark-token', created: new Date().toISOString(), scopes: ['filesystem','system','diagnostics','router'], shell_enabled: false, allowed_paths: [], denied_paths: [] }],
  };
  state.audit = null;
  const { app } = buildApp(state);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/benchmark-token/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body });
  const text = await response.text();
  const elapsedMs = performance.now() - started;
  const match = text.match(/data: (.+)$/m);
  const payload = JSON.parse(match ? match[1] : text);
  await new Promise(resolve => server.close(resolve));
  if (previous === undefined) delete process.env.RAMCP_TOOL_EXPOSURE; else process.env.RAMCP_TOOL_EXPOSURE = previous;
  return { mode: scoped ? 'scoped' : 'all', tools: payload.result.tools.length, responseBytes: Buffer.byteLength(text), elapsedMs: Number(elapsedMs.toFixed(3)) };
}

console.log(JSON.stringify({ all: await run(false), scoped: await run(true) }, null, 2));
