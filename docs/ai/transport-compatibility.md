# Transport Compatibility

Why the server speaks three MCP dialects, and the exact bugs that forced
each one. This file exists so nobody "simplifies" it away.

## The three dialects

| # | Dialect | Who speaks it | Handshake | Replies |
|---|---|---|---|---|
| 1 | Streamable HTTP, **stateless** | ChatGPT, Grok | POST initialize | inside the POST response; session id ignored |
| 2 | Streamable HTTP, **stateful** | Claude (new SDK), most reference clients | POST initialize → `Mcp-Session-Id` response header | every request carries the id; GET opens a server→client notification stream |
| 3 | **Legacy SSE** (2024-11-05) | Claude's connector UI auto-selects it when the URL ends in `/sse` | **GET** → `event: endpoint` frame announces the POST URL + sessionId | replies ride the long-lived GET stream; POSTs are 202 |

All three are served on **both** endpoint paths (`/mcp` and `/sse`, plus any
configured aliases) — the URL does not determine the dialect; the request
shape does.

## Dispatch rules (server/app.ts)

```
POST with Mcp-Session-Id:
    known session    → that session's StreamableHTTP transport
    unknown session  → 404 "Session not found"   (client re-initializes)
POST initialize (no id) → new stateful session, id in response header
POST anything else (no id) → stateless throwaway transport  (ChatGPT/Grok)
GET  with Mcp-Session-Id   → streamable notification stream for that session
GET  without id            → legacy SSE handshake (event: endpoint …)
POST /<token>/<path>/messages?sessionId=… → legacy SSE post-back leg
DELETE with id             → session teardown (204)
```

`normalizeAccept()` widens every Accept header to
`application/json, text/event-stream` (GET → `text/event-stream`) before
the SDK sees it. The SDK enforces the spec strictly and answers 406 to
`*/*` or single-type Accepts; real clients send all of those.

Responses are **SSE-framed** (`enableJsonResponse: false`) — the spec's
reference behavior, and the framing every dialect we've seen accepts.
Plain-JSON mode was tried; Claude's connector silently dropped it.

## The incident log (each of these shipped and hurt)

1. **No session id** → Claude retried initialize every ~60s and reported
   "Couldn't reach <server>". Fix: stateful sessions (v2.2.0),
   `sessions.ts` store with 30-min idle TTL, 200 cap, per-token binding.
2. **406 on honest Accepts** → clients sending `*/*` or
   `text/event-stream` alone got rejected by the SDK's strict check.
   Fix: normalizeAccept (v2.2.1).
3. **`Unknown SSE event: endpoint`** → the legacy transport was bolted on
   by hijacking **every** GET; a stateful client opening its notification
   stream received the legacy `event: endpoint` frame and aborted its whole
   TaskGroup. Fix: dispatch GETs by the Mcp-Session-Id header (v2.2.2/3).
4. **Plain-JSON responses dropped** → initialize answered 200 +
   `application/json`, Claude read it and silently gave up. Fix: SSE
   framing everywhere (v2.2.4). Diagnosed with a byte-logging wire proxy:
   the client's exact headers/body made it obvious Claude got a *valid*
   reply and still walked away — only the framing differed.

## Verification (do not trust, run)

The byte-exact Claude simulation lives in git history
(`python-httpx/0.28.1` + `clientInfo.name: "Anthropic"`); the pinned suite
covers the matrix:

- `tests/sessions.test.ts` — stateful handshake, routing, hijack-refusal,
  DELETE teardown, stateless fallback
- `tests/get-dispatch.test.ts` — GET with id never emits `endpoint`; GET
  without id always does
- `tests/legacy-sse.test.ts` — full 2024-11-05 handshake over `/sse` and
  `/mcp`, sessionId-less POST-back → 400, unknown → 404, cross-token → 403
- `tests/accept-compat.test.ts` — six Accept variants all initialize

## Edge / proxy notes (production config)

- nginx: `proxy_buffering off`, `proxy_request_buffering off`,
  `proxy_set_header Connection ""`, `chunked_transfer_encoding on`,
  `gzip off`, `add_header X-Accel-Buffering no`, read/send timeouts 3600s —
  a legacy SSE stream idles between tool calls; the default 60s proxy
  timeouts kill it. The gateway sends `: keepalive` comments every 15s so
  intermediate hops don't reap the stream.
- Cloudflare proxies all three dialects fine (verified from the edge).
- Quick tunnels on filtered networks can register but not carry traffic —
  `ramcp tunnel` self-verifies and warns instead of handing out a dead URL
  (that's environment, not protocol; http2-over-TCP is forced for the same
  reason — QUIC is blocked on some ISPs).
