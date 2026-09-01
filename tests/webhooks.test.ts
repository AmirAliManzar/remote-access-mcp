import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notifyWebhooks, webhookStats, __resetWebhooksForTests } from '../src/core/webhooks.js';
import type { RamcpConfig } from '../src/core/config.js';

/**
 * Webhooks are fire-and-forget POSTs after each audited tool call.
 * The contract that matters:
 *  - a hook subscribed to tool.error only hears about errors
 *  - '*' hears everything
 *  - identical events inside 10s dedupe into one notification
 *  - a dead endpoint never throws into the caller
 */

let server: http.Server;
let received: Array<{ headers: Record<string, string>; body: any }> = [];
let port = 0;
let failMode = false;

beforeEach(async () => {
  __resetWebhooksForTests();
  received = [];
  failMode = false;
  server = http.createServer((req, res) => {
    if (failMode) { res.statusCode = 500; res.end('nope'); return; }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers as Record<string, string>, body: JSON.parse(body) });
      res.statusCode = 200;
      res.end('ok');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

const mkCfg = (events: string[], enabled = true): RamcpConfig => ({
  host: '127.0.0.1', port: 0, public_host: '', mcp_path: '/mcp', log_level: 'silent',
  audit: { enabled: true, db_path: '/dev/null' }, read_only: false,
  tokens: [], fleet: { hosts: [] },
  webhooks: [{ url: `http://127.0.0.1:${port}/hook`, events, enabled }],
});

const row = (isError: number) => ({
  ts: Date.now(), token_fingerprint: 'fp', tool: 'run_command',
  args_json: '', ok: isError ? 0 : 1, is_error: isError, duration_ms: 5,
});

async function settle(ms = 300) { await new Promise(r => setTimeout(r, ms)); }

describe('webhooks', () => {
  it('delivers error events to a tool.error hook', async () => {
    notifyWebhooks(mkCfg(['tool.error']), row(1));
    await settle();
    expect(received).toHaveLength(1);
    expect(received[0].body.type).toBe('tool.error');
    expect(received[0].body.tool).toBe('run_command');
    expect(received[0].headers['content-type']).toBe('application/json');
  });

  it('does not deliver successes to an error-only hook', async () => {
    notifyWebhooks(mkCfg(['tool.error']), row(0));
    await settle();
    expect(received).toHaveLength(0);
  });

  it('* subscribes to everything', async () => {
    notifyWebhooks(mkCfg(['*']), row(0));
    await settle();
    expect(received).toHaveLength(1);
    expect(received[0].body.type).toBe('tool.success');
  });

  it('dedupes identical events within the window', async () => {
    for (let i = 0; i < 5; i++) notifyWebhooks(mkCfg(['tool.error']), row(1));
    await settle();
    expect(received).toHaveLength(1);
  });

  it('disabled hooks are silent', async () => {
    notifyWebhooks(mkCfg(['*'], false), row(0));
    await settle();
    expect(received).toHaveLength(0);
  });

  it('a dead endpoint records a failure and never throws', async () => {
    failMode = true;
    expect(() => notifyWebhooks(mkCfg(['tool.error']), row(1))).not.toThrow();
    await settle();
    expect(webhookStats().failed).toBeGreaterThan(0);
    expect(received).toHaveLength(0);
  });
});
