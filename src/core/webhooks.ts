import fs from 'node:fs';
import type { RamcpConfig } from './config.js';
import type { AuditEntry } from './audit.js';

/**
 * Outbound webhook notifications for audit events.
 *
 * Fire-and-forget by design: a slow or dead webhook endpoint must never
 * stall a tool call. POSTs are bounded (5s timeout), deduplicated per event
 * type within a short window (a chat client firing 50 tool calls in one turn
 * should not hammer the webhook 50 times), and failures are swallowed into
 * a counter the CLI can read.
 */

const DEDUPE_WINDOW_MS = 10_000;

export interface WebhookEvent {
  type: string;                 // e.g. 'tool.error', 'auth.failure', 'tool.success'
  tool?: string;
  token_fingerprint?: string;
  detail?: Record<string, unknown>;
  ts: number;
}

const recentFingerprints = new Map<string, number>();
let sentCount = 0;
let failedCount = 0;

export function webhookStats(): { sent: number; failed: number } {
  return { sent: sentCount, failed: failedCount };
}

/** Test hook: clear dedupe window and counters so suites stay independent. */
export function __resetWebhooksForTests(): void {
  recentFingerprints.clear();
  sentCount = 0;
  failedCount = 0;
}

/** Classify an audit row into event types worth notifying about. */
function classify(entry: Omit<AuditEntry, 'prev_hash' | 'hash'>): string | null {
  if (entry.is_error === 1) return 'tool.error';
  // auth failures never reach the audit log (401 happens before tools), so
  // errors + successes are the two streamable events.
  return 'tool.success';
}

function dedupeKey(ev: WebhookEvent): string {
  return `${ev.type}:${ev.tool || '-'}:${ev.token_fingerprint || '-'}`;
}

/** Notify all enabled webhooks subscribed to this event type. Non-blocking. */
export function notifyWebhooks(cfg: RamcpConfig, entry: Omit<AuditEntry, 'prev_hash' | 'hash'>): void {
  const hooks = (cfg.webhooks || []).filter(w => w.enabled && w.url);
  if (!hooks.length) return;

  const type = classify(entry);
  if (!type) return;

  // Skip if no hook actually subscribes to this type ('*' = all).
  const matching = hooks.filter(w => w.events.includes('*') || w.events.includes(type));
  if (!matching.length) return;

  const ev: WebhookEvent = {
    type,
    tool: entry.tool,
    token_fingerprint: entry.token_fingerprint,
    detail: { is_error: entry.is_error, duration_ms: entry.duration_ms },
    ts: entry.ts,
  };

  // Dedupe identical events inside the window: a retry loop of the same
  // failing tool is one notification, not twenty.
  const key = dedupeKey(ev);
  const now = Date.now();
  const last = recentFingerprints.get(key) || 0;
  if (now - last < DEDUPE_WINDOW_MS) return;
  recentFingerprints.set(key, now);
  if (recentFingerprints.size > 500) {
    // prune map so long-running gateways don't grow it forever
    for (const [k, t] of recentFingerprints) {
      if (now - t > DEDUPE_WINDOW_MS) recentFingerprints.delete(k);
    }
  }

  for (const hook of matching) {
    void fetch(hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'remote-access-mcp-webhook' },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(5000),
    }).then(r => { if (r.ok) sentCount++; else failedCount++; })
      .catch(() => { failedCount++; });
  }
}
