import type { ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

/**
 * Legacy SSE transport support (MCP 2024-11-05 style).
 *
 * Claude's connector UI auto-selects "SSE (legacy)" whenever the URL ends in
 * `/sse`, and that transport speaks a different dialect than Streamable HTTP:
 *
 *   1. client: GET  /<token>/sse          → server opens an SSE stream and
 *                                            emits `event: endpoint` carrying
 *                                            the POST URL + sessionId
 *   2. client: POST /<token>/messages?sessionId=…  (one request per message)
 *   3. server: replies arrive back over the SSE stream from step 1
 *
 * Streamable HTTP instead carries the reply in the POST response. Supporting
 * both means every client works regardless of which one it picks.
 */

const KEEPALIVE_MS = 15_000;

export interface LegacySession {
  id: string;
  server: McpServer;
  transport: SSEServerTransport;
  /** Fingerprint of the token that opened the stream — not transferable. */
  tokenId: string;
  keepAlive: NodeJS.Timeout;
  created: number;
}

export class LegacySseStore {
  private sessions = new Map<string, LegacySession>();

  /**
   * Register a live stream. A keep-alive comment frame is sent periodically:
   * Cloudflare and nginx both drop idle upstream connections, and an SSE
   * stream that carries no traffic between tool calls looks idle to them.
   */
  add(session: Omit<LegacySession, 'keepAlive'>, res: ServerResponse): void {
    const keepAlive = setInterval(() => {
      if (res.writableEnded) return;
      try { res.write(': keepalive\n\n'); } catch { /* stream gone */ }
    }, KEEPALIVE_MS);
    keepAlive.unref?.();
    this.sessions.set(session.id, { ...session, keepAlive });
  }

  get(id: string): LegacySession | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    clearInterval(s.keepAlive);
    this.sessions.delete(id);
    s.transport.close().catch(() => {});
    s.server.close().catch(() => {});
  }

  size(): number {
    return this.sessions.size;
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.delete(id);
  }
}
