import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { buildApp, createGatewayState, type GatewayState } from '../src/server/app.js';

const TOKEN = 'legacy-sse-test-token';
const OTHER = 'legacy-other-token';

let server: http.Server;
let port: number;
let state: GatewayState;

beforeAll(async () => {
  state = createGatewayState();
  state.cfg = {
    host: '127.0.0.1', port: 0, public_host: '', mcp_path: '/sse',
    mcp_path_aliases: ['/mcp'],
    log_level: 'silent',
    audit: { enabled: false, db_path: '/dev/null' },
    read_only: false,
    tokens: [
      { id: 'a', name: 'a', token: TOKEN, created: new Date().toISOString(), scopes: [], shell_enabled: false, allowed_paths: [], denied_paths: [] },
      { id: 'b', name: 'b', token: OTHER, created: new Date().toISOString(), scopes: [], shell_enabled: false, allowed_paths: [], denied_paths: [] },
    ],
  };
  state.audit = null;
  const { app } = buildApp(state);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  state.legacySse.closeAll();
  state.sessions.closeAll();
  await new Promise<void>((r) => server.close(() => r()));
});

interface Stream {
  endpoint: string;
  messages: string[];
  close(): void;
}

/** Open a legacy SSE stream and resolve once the endpoint event arrives. */
function openStream(tokenPath: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    let endpoint: string | null = null;
    const req = http.request(
      { host: '127.0.0.1', port, path: tokenPath, method: 'GET', headers: { Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) { reject(new Error(`status ${res.statusCode}`)); return; }
        let buf = '';
        res.on('data', (c: Buffer) => {
          buf += c.toString();
          let i: number;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /event: (.+)/.exec(frame)?.[1];
            const data = /data: ([\s\S]+)/.exec(frame)?.[1];
            if (ev === 'endpoint' && data && !endpoint) {
              endpoint = data;
              resolve({ endpoint, messages, close: () => req.destroy() });
            } else if (data) {
              messages.push(data);
            }
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
    setTimeout(() => reject(new Error('no endpoint event within 5s')), 5000);
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode!, body: d })); },
    );
    r.on('error', reject);
    r.write(JSON.stringify(body));
    r.end();
  });
}

const settle = () => new Promise((r) => setTimeout(r, 400));

/**
 * Claude's connector picks "SSE (legacy)" automatically for URLs ending in
 * /sse. That transport opens a GET stream, learns a POST-back URL from an
 * `event: endpoint` frame, and receives every reply over the stream — a
 * different shape from Streamable HTTP, which answers inside the POST.
 * Both must work on the same endpoint.
 */
describe('legacy SSE transport (Claude "SSE (legacy)")', () => {
  it('GET opens a stream and announces the POST-back endpoint', async () => {
    const s = await openStream(`/${TOKEN}/sse`);
    expect(s.endpoint).toContain('/messages');
    expect(s.endpoint).toContain('sessionId=');
    expect(s.endpoint).toContain(TOKEN);
    s.close();
  });

  it('completes a full handshake with replies over the stream', async () => {
    const s = await openStream(`/${TOKEN}/sse`);

    const init = await post(s.endpoint, {
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } },
    });
    expect(init.status).toBe(202); // reply travels over SSE, not the POST
    await settle();
    expect(s.messages.some(m => m.includes('serverInfo'))).toBe(true);

    await post(s.endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' });
    await post(s.endpoint, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await settle();

    const toolsReply = s.messages.find(m => /"result":\{"tools"/.test(m));
    expect(toolsReply).toBeTruthy();
    expect(toolsReply).toContain('system_info');

    await post(s.endpoint, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'system_info', arguments: {} } });
    await settle();
    expect(s.messages.some(m => m.includes('hostname'))).toBe(true);

    s.close();
  });

  it('works on the /mcp alias too', async () => {
    const s = await openStream(`/${TOKEN}/mcp`);
    expect(s.endpoint).toContain('/mcp/messages');
    s.close();
  });

  it('rejects POST-back without a sessionId', async () => {
    const r = await post(`/${TOKEN}/sse/messages`, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.status).toBe(400);
  });

  it('rejects an unknown sessionId', async () => {
    const r = await post(`/${TOKEN}/sse/messages?sessionId=nope`, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.status).toBe(404);
  });

  it('refuses to reuse another token\'s session', async () => {
    const s = await openStream(`/${TOKEN}/sse`);
    const hijack = s.endpoint.replace(TOKEN, OTHER);
    const r = await post(hijack, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.status).toBe(403);
    s.close();
  });

  it('requires a valid token to open a stream', async () => {
    await expect(openStream('/not-a-real-token/sse')).rejects.toThrow(/status 401/);
  });
});

describe('Streamable HTTP unaffected by legacy support', () => {
  it('POST on the same URL still answers inline', async () => {
    const r = await post(`/${TOKEN}/sse`, {
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'chatgpt', version: '1' } },
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain('serverInfo');
  });
});
