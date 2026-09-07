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
history (core/fleet.ts) if ever needed again).

---

## ADR-014 — Durable task orchestration is layered over the existing tool gate
**Status:** accepted · **Date:** 2026-09-07

Phase 3 introduces `task` as an orchestration layer, not a second execution
security model. Every action is still dispatched through the existing wrapped
MCP tool handler, so token scopes, read-only mode, path policy, command
allowlists, audit, context optimization, and plugin policy remain authoritative.

Task state is persisted only under RAMCP's own `dataDir()` and is token-isolated.
The workflow engine adds graph validation, bounded parallel action execution,
retry/timeout, explicit verification hooks, supervised pause/resume, and
compensation rollback. Specialized agent profiles are deterministic
capability/autonomy constraints; they are not hidden model processes and do
not touch external Codebase Memory state.

---

## ADR-015 — Browser and infrastructure integrations stay fixed-command and policy-first
**Status:** accepted · **Date:** 2026-09-07

Phase 5 adds headless browser access and infrastructure inspection without
introducing arbitrary shell execution. Browser URLs are restricted to public
HTTP(S) targets with the same private/metadata SSRF posture as web tools, and
screenshots must pass the existing path policy. Docker and Kubernetes calls use
fixed executables plus validated positional arguments rather than shell strings;
mutating Docker actions remain subject to read-only policy. Cloudflare access is
limited to the existing `cloudflared` binary and never exposes credentials.
Existing MySQL/PostgreSQL/Redis adapters remain unchanged and authoritative.

---

## ADR-016 — Automation is durable, token-isolated, and policy-first
**Status:** accepted · **Date:** 2026-09-07

Phase 6 stores automation rules only in RAMCP's own data directory and keys
ownership to the authenticated token fingerprint. Conditions are evaluated
locally and actions are bounded to a small declarative list; automation cannot
invoke control-plane, approval-decision, or plugin lifecycle tools. Mutating
lifecycle operations and action execution remain behind the normal policy,
scope, read-only, path, audit, and command-policy gates.

Persistence uses a cross-process filesystem lock with atomic replacement, while
rule execution uses an atomic per-rule claim so multiple gateway processes do
not intentionally execute the same rule concurrently. Event chains carry an
origin/depth guard and automation-origin tool events cannot recursively trigger
more automation. The authenticated inbound webhook endpoint selects rules by
token and never copies the token into the event payload. Optional integration
MCP children are started only when an automation action actually requests one,
so ordinary automation does not block on Codebase Memory/Context7 startup.

Existing schedules, outbound webhooks, and health watchers remain compatible
rather than being replaced. No external Codebase Memory state is read or
modified by the automation persistence layer.

---

## ADR-017 — Autonomous operations are opt-in and risk-gated
**Status:** accepted · **Date:** 2026-09-07

Phase 7 introduces centralized autonomy decisions and bounded self-healing.
Autonomous execution is disabled unless `RAMCP_AUTONOMOUS=1`; high-risk and
critical recovery additionally require explicit `RAMCP_AUTONOMOUS_HIGH_RISK=1`
and `RAMCP_AUTONOMOUS_CRITICAL=1`. Recovery rules are token-isolated,
rate-limited, attempt-bounded, persisted atomically, and executed through the
normal wrapped tool path. Automation/recovery recursion is not permitted.

---

## ADR-018 — Plugins are untrusted child processes, not in-process extensions
**Status:** accepted · **Date:** 2026-09-07

Phase 8 removes the previous in-process plugin execution model. An installed
plugin is copied into RAMCP's own plugin directory, validated, fingerprinted,
and only then exposed. The stored fingerprint must continue to match before
every plugin process is started; modified or unverifiable plugins are skipped
fail-closed.

Plugin tools are discovered through a short-lived MCP child process and
exposed to the gateway under a `plugin_<name>__<tool>` namespace. Each actual
invocation starts a fresh child process, bounds startup/execution time, and
closes the child after the call. This avoids persistent plugin processes and
plugin lifecycle state surviving independently of the gateway session.

On Linux, the child runs in a separate network namespace with a deny-by-default
network filter when `unshare` and `nft` are available. Node's permission system
limits filesystem reads to the plugin and required runtime dependencies,
permits writes only to the plugin's dedicated `data/` directory when `fs.write`
is explicitly declared, and permits child processes only when `process` is
explicitly declared. A network-blocking preload adds defense-in-depth for
common Node networking APIs. On platforms without the built-in sandbox,
plugins are disabled by default; `RAMCP_PLUGIN_UNSANDBOXED=1` is an explicit
local-trust escape hatch.

Installation rejects absolute/traversing entries, invalid names/versions/
permissions, symbolic links, oversized trees, and malformed manifests. Plugin
lifecycle tools require the `plugins` scope and remain blocked in read-only
mode. Plugin tool exposure also requires the plugin's declared gateway scopes
to be available to the token. There is intentionally no remote registry or
automatic download path in this phase; installation is local and explicit.

The sandbox is defense-in-depth rather than a claim of a universal kernel-grade
security boundary across every operating system. The default is fail-closed
when the required Linux sandbox is unavailable.

---

## ADR-019 — Plugin registry mutations are serialized across gateway processes
**Status:** accepted · **Date:** 2026-09-08

Phase 9 adds a cross-process filesystem guard around plugin installation and
removal. The registry lockfile is still replaced atomically, while failed
installations remove their partial destination and revalidate the copied
manifest before committing the integrity record. This preserves the simple
local filesystem model without allowing concurrent gateway processes to
produce competing plugin registry state.
