import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../src/core/audit.js';

/**
 * Regression: better-sqlite3's native Statement destructor SIGABRTs Node
 * when writes happen inside the stateless MCP request loop (observed in
 * production 2026-08-31, crashed at ~8 requests). The audit log is now a
 * plain JSONL implementation; this test pins that behavior — 30 full
 * stateless request cycles WITH audit writes must complete without
 * crashing the process.
 */
describe('audit × stateless MCP loop (crash regression)', () => {
  it('survives 30 request cycles with audit writes', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-crash-'));
    const audit = new AuditLog(path.join(tmp, 'audit.jsonl'));

    for (let i = 0; i < 30; i++) {
      const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {} } });
      // register tools like the real gateway does (42 of them)
      for (let j = 0; j < 42; j++) {
        server.registerTool(`tool${j}`, { description: 'x' }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      // audit write mid-lifecycle, like the real per-request wrapper
      audit.record({
        ts: Date.now(),
        token_fingerprint: 'fp' + i,
        tool: 'tool0',
        args_json: '{}',
        ok: 1,
        is_error: 0,
        duration_ms: 3,
      });
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }

    const rows = audit.query({ limit: 100 });
    expect(rows.length).toBe(30);
    expect(audit.verify()).toBeNull(); // chain intact
  }, 30_000);
});
