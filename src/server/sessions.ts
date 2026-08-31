import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * Session store for stateful MCP clients.
 *
 * Why both modes exist: ChatGPT and Grok drive the transport statelessly —
 * every POST is self-contained and they ignore Mcp-Session-Id. Claude's
 * connector does the opposite: it expects a session id back from
 * `initialize` and refuses to continue without one (it retries initialize
 * a few times, then reports "Couldn't reach <server>").
 *
 * So the gateway issues a session on every initialize, remembers it, and
 * routes follow-up requests that carry the id. Clients that ignore the id
 * still work through the stateless fallback path.
 */
export interface Session {
  id: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  /** Fingerprint of the token that opened the session — sessions are not transferable. */
  tokenId: string;
  created: number;
  lastSeen: number;
}

const IDLE_TTL_MS = 30 * 60 * 1000; // 30 min without traffic → reap
const MAX_SESSIONS = 200;           // hard cap; oldest idle gets evicted first

export class SessionStore {
  private sessions = new Map<string, Session>();
  private lastSweep = Date.now();

  newId(): string {
    return randomUUID();
  }

  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (s) s.lastSeen = Date.now();
    return s;
  }

  set(session: Session): void {
    this.evictIfNeeded();
    this.sessions.set(session.id, session);
  }

  delete(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    // Best effort teardown — a half-closed transport must not wedge the store.
    s.transport.close().catch(() => {});
    s.server.close().catch(() => {});
  }

  size(): number {
    return this.sessions.size;
  }

  /** Drop idle sessions. Cheap: runs at most once a minute. */
  sweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeen > IDLE_TTL_MS) this.delete(id);
    }
  }

  private evictIfNeeded(): void {
    if (this.sessions.size < MAX_SESSIONS) return;
    let oldestId: string | null = null;
    let oldestSeen = Infinity;
    for (const [id, s] of this.sessions) {
      if (s.lastSeen < oldestSeen) { oldestSeen = s.lastSeen; oldestId = id; }
    }
    if (oldestId) this.delete(oldestId);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.delete(id);
  }
}
