# Decision Records (ADR)

Short, dated records of *why* the code is the way it is. Each one encodes a
lesson that cost real debugging time. When one of these decisions blocks
something you're trying to do, don't quietly route around it — write a new
record superseding the old one.

---

## ADR-001 — Express + per-request McpServer builds
**Status:** accepted · **Date:** 2026-08-30

The gateway builds a **fresh `McpServer` with all tools re-registered for
every request** (stateless dialect) or per session (stateful).

Why: (a) policy mutations — CLI, config hot-reload, or in-chat
`allow_path` — must apply on the *next* request, not after a restart;
(b) per-request builds bind the calling token's record into the handlers,
so revocation/rotation takes effect mid-conversation; (c) the MCP SDK
guidance for our compat matrix is one transport per request anyway.

Cost: registration overhead per request (~1ms measured). Accepted.

---

## ADR-002 — Dual auth: Bearer header *and* token-in-URL
**Status:** accepted · **Date:** 2026-08-30

ChatGPT custom connectors cannot set custom headers, so the token rides in
the URL path (`/<token>/mcp`). Everything else uses `Authorization: Bearer`.
Both resolve through the same timing-safe comparison.

---

## ADR-003 — Tunnel URL lives in runtime.json, never config
**Status:** accepted · **Date:** 2026-08-31

Quick-tunnel URLs are valid only while the gateway process runs. The first
implementation persisted the URL into `config.json`'s `public_host` — and
one test run on the production server **clobbered the real domain**, after
which `ramcp url` printed a dead trycloudflare URL to the user.

Fix: `runtime.json` = {pid, tunnel_url, host, port, started}, written on
boot, pid-checked on read (stale → ignored), cleared on exit including
`process.on('exit')` for Windows service stops. `ramcp url` prefers the
live tunnel. Pinned by `tests/runtime-state.test.ts`.

---

## ADR-004 — Pure ESM, no require() in src/
**Status:** accepted · **Date:** 2026-08-31

A `require()` in `src/cli/main.ts` passed the entire test suite (vitest's
CJS interop tolerates it) and **crash-looped production** within a second
of every systemd start. Diagnosis needed a boot test that runs the built
output under plain node — which now exists (`tests/boot.test.ts`) and
should be the pattern for anything touching startup paths.

---

## ADR-005 — Audit log is JSONL, not better-sqlite3
**Status:** accepted · **Date:** 2026-08-31

The original audit used better-sqlite3. In the stateless request loop its
native `Statement` destructor aborted Node with SIGABRT (~8 requests in,
native stack trace pointing at `Statement::~Statement`). Root cause:
better-sqlite3's teardown hooks racing the SDK's per-request transports.

The rewrite is a plain append + fsync JSONL file with the same hash chain,
zero native code in the dependency tree, and a regression test that runs
30 full stateless cycles with audit writes (`tests/crash-regression.test.ts`).
sqlite_query/sqlite_schema keep better-sqlite3 for *user* databases (open
per call, closed in-finally) — that usage never crashed.

---

## ADR-006 — Hermetic tests: build gateway state explicitly
**Status:** accepted · **Date:** 2026-08-31

Tests that called `buildApp()` without seeding state read the **host's real
config**. It worked until the production server deployed with
`mcp_path: /sse` — then 10 tests failed only-when-the-service-was-running.
All suites now construct explicit `GatewayState` objects (see any
`tests/*.test.ts` `beforeAll`).

---

## ADR-007 — Fleet mode removed (single machine by design)
**Status:** accepted · **Date:** 2026-09-01 · **Supersedes:** the v2.4.0 fleet feature

Fleet (SSH to N machines, per-host tool allowlists, 14 remote-capable
tools, `ramcp fleet` CLI) was fully implemented, tested (including live-SSH
and fake-ssh suites), published as 2.4.x — and then **removed entirely** in
3.0.0 by owner decision: the product is one gateway per machine; multi-
server orchestration is not the problem this project solves.

What the removal kept: webhooks and `config export/import` (independent
value). What it took with it: `src/core/fleet.ts`, `src/tools/fleet.ts`,
the `host` parameter on 14 tools, fleet CLI/scopes/config, three test
files. `ramcp fleet` is now an unknown command (pinned by a test).

---

## ADR-008 — Never omit schema parameters conditionally
**Status:** accepted · **Date:** 2026-09-01 · **Learned from:** the fleet era

When a tool's schema includes a parameter only under some conditions
(e.g., `host` only when fleet hosts exist), the MCP SDK **silently strips**
client arguments that aren't in the current schema. Consequence observed on
production: a client sending `run_command {command, host: "ghost"}$` to a
fleet-less gateway had `host` dropped and the **"remote" command executed
locally on the gateway** — a silent security downgrade, not an error.

Rule: parameters that gate security-relevant behavior stay in the schema
always; the *handler* refuses with a clear error when the capability is
absent. (Superseded by ADR-007 removing the host param outright, but the
rule stands for anything like it.)

---

## ADR-009 — SSE-framed responses by default
**Status:** accepted · **Date:** 2026-08-31

`enableJsonResponse: true` (plain-JSON replies) works for ChatGPT/Grok but
Claude's connector read a valid 200 initialize reply and silently
abandoned the connection. SSE framing (`event: message\ndata: …`,
`content-type: text/event-stream`) is the reference behavior and the only
framing observed to satisfy every dialect we've tested. The wire-log proxy
session that proved this is described in transport-compatibility.md.

---

## ADR-010 — execFile does not support the `input` option
**Status:** accepted · **Date:** 2026-09-01

`promisify(execFile)({... input})` never closes the child's stdin — the
call hangs until timeout (fleet's remote file writes hung 5s→timeout every
time before this was understood; a minimal `bash -c cat` repro confirmed
it's the API, not our code). Pattern: when stdin must be piped, use
`spawn()` and end the stream manually. The helper shape lives in git
history (core/fleet.ts) if ever needed again.
