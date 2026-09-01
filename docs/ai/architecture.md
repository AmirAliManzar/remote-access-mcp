# Architecture

How the gateway is put together, for AI agents (and humans) who need to
reason about it before changing it.

## Module map

```
src/
├── core/                    # framework-free building blocks
│   ├── config.ts            # RamcpConfig + tokens; loads/migrates config.json
│   ├── policy.ts            # path sandbox, scope groups, tool permission gate
│   ├── audit.ts             # JSONL hash-chain audit log + redaction
│   ├── crypto.ts            # timing-safe token compare
│   ├── rate-limit.ts        # token-bucket per token
│   ├── platform.ts          # OS detection, shells, dataDir, runtime state
│   ├── tunnel.ts            # cloudflared quick-tunnel lifecycle
│   ├── webhooks.ts          # fire-and-forget event notifications
│   └── context.ts           # ConfigWatcher (hot-reload) + ToolContext
├── server/
│   ├── app.ts               # express app: auth, routes, sessions, MCP wiring
│   ├── run.ts                # boot: listen, tunnel, runtime state, shutdown
│   ├── sessions.ts           # stateful MCP session store (Claude dialect)
│   └── legacy-sse.ts         # 2024-11-05 SSE transport + keepalive
├── tools/                   # one file per suite, registered per request
│   ├── filesystem.ts shell.ts system.ts http.ts git.ts sqlite.ts
│   ├── logs.ts services.ts packages.ts schedule.ts security.ts
│   ├── project.ts web.ts planning.ts ops.ts policy.ts index.ts
└── cli/main.ts              # ramcp — all commands
```

## Request lifecycle (the part that matters most)

One MCP POST travels this path:

```
nginx ─→ express
        │  app.all('/<token>/sse') or ('/sse' + Bearer header)
        ├─ authenticate(presented)                     [core/crypto + config]
        │    reloads config if mtime changed  (hot-reload)
        │    timing-safe compare against all tokens
        ├─ rateLimited(token)?  → 429
        ├─ normalizeAccept(req)                       [compat: never 406]
        ├─ session routing:
        │    Mcp-Session-Id present?
        │      ├─ known session → its StreamableHTTP transport
        │      └─ unknown → 404 (client restarts cleanly)
        │    no session id:
        │      ├─ initialize → new stateful session (id in response header)
        │      └─ anything else → stateless throwaway transport
        ├─ buildServerFor(token)                      [per request!]
        │    McpServer + registerAllTools(server, ctx)
        │    every tool handler wrapped: try/catch → audit → webhooks
        └─ transport.handleRequest → tool executes → response
```

**Tools are re-registered for every request.** That is what makes policy
edits (CLI or in-chat `allow_path`) apply on the next request with zero
restarts. Do not "optimize" this by caching servers across requests — it
would break hot-reload and per-token isolation.

`ctx: ToolContext` carries `{ cfg, token, readOnly, persist, audit }`.
The token record is looked up fresh per request, so a revoked token dies
mid-conversation.

## The three dialects (why server code looks redundant)

| Client | Dialect | First request | Follow-ups |
|---|---|---|---|
| ChatGPT, Grok | Streamable, stateless | POST initialize (200 JSON/SSE) | fresh POST per call, ignores session id |
| Claude (new SDK) | Streamable, stateful | POST initialize → **Mcp-Session-Id header back** | same id on every request; GET opens notification stream |
| Claude (auto for `/sse` URLs) | Legacy SSE 2024-11-05 | **GET** stream → `event: endpoint` frame | POST to `/<token>/sse/messages?sessionId=…`, replies ride the stream |

GET disambiguation: a GET **with** `Mcp-Session-Id` is a stateful client
opening its notification stream; **without** it, it's a legacy client
starting the handshake. Mixing these up sends `event: endpoint` to a
stateful client, which aborts with `Unknown SSE event: endpoint` — that
exact bug killed Claude connectors for a full day. Tests pin it
(`tests/get-dispatch.test.ts`).

## Data & state

| File | Lives in | Written by | Lifetime |
|---|---|---|---|
| `config.json` | dataDir per OS | CLI, policy tools | persistent; 0600 |
| `audit.jsonl` | dataDir | audit wrapper | append-only, hash-chained |
| `runtime.json` | dataDir | gateway boot | ephemeral — pid-checked, cleared on exit |
| `schedule.json`, `plans.json`, `snapshots.json`, `snapshots/` | dataDir | tools | persistent |

The tunnel URL **only** ever goes to `runtime.json`. Writing it to config
would clobber a server's real `public_host` the moment someone ran
`ramcp tunnel` on it (that happened; ADR-003).

## Cross-platform layer

`core/platform.ts` normalizes: which shell (`bash -lc` / `pwsh` / `cmd.exe`),
where data lives, how paths compare (case-insensitive on Win/mac),
`which()`, `hasSystemd()`. Tools call `shellCommand()` instead of hardcoding
bash — Windows compat lives or dies here.

## Service installers

`ramcp service install` writes a systemd unit (Linux), a launchd plist
(macOS, per-user, no sudo), or a schtasks entry (Windows, logon trigger).
The unit points at `dist/server/run.js` under the *global npm* install path —
`ramcp upgrade` rewrites nothing but must restart the right manager per OS.
