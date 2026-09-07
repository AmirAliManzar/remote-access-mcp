# Roadmap

The vision: one command turns any machine into an AI-agent-accessible endpoint — securely, transparently, and without heavy dependencies.

## v1.x — Core gateway (done)

- [x] MCP server over Streamable HTTP (stateless), Node.js + TypeScript
- [x] Dual auth: `Authorization: Bearer` header or `/<token>/mcp` URL path
- [x] Filesystem tools with allow/deny path policy engine (symlink-safe)
- [x] Shell tools behind an opt-in flag
- [x] System, HTTP, git, SQLite suites
- [x] CLI (`ramcp`): init, start, url, token, policy, service, status
- [x] systemd service + nginx vhost installer
- [x] One-liner install script
- [x] npm package: `remote-access-mcp`

## v2.0 — Multi-tenant & audit (done)

- [x] **Multi-token** with per-token: scopes (tool groups), allowed/denied paths, shell flag, read-only, rate limit, expiry
- [x] **Tamper-evident audit log** — JSONL hash chain, `ramcp audit chain`, secret redaction
- [x] **`ramcp doctor`** — tokens, port, gateway health, nginx vhost, public URL, audit chain in one pass
- [x] **Hot-reload** — policy changes apply on the next request, no restart
- [x] **Global read-only mode** — kill-switch for all mutating tools
- [x] **SSRF guards** — loopback/private/metadata ranges refused on all fetch tools
- [x] **Injection guards** — git verb whitelist, SQL single-statement + ATTACH block, unit-name validation
- [x] Suites: logs/journal, systemd control, packages, scheduler, security scans, project analysis, planning/snapshots, web_fetch, ops

## v2.2 — Transport compatibility (done)

- [x] Stateful sessions (`Mcp-Session-Id`) alongside the stateless dialect
- [x] Legacy SSE transport (2024-11-05) — Claude's connector auto-selects it for `/sse` URLs
- [x] Accept-header tolerance — non-spec clients get normalized instead of 406
- [x] Configurable endpoint path (`mcp_path`), aliases keep old URLs alive

## v2.3 — Cross-platform (done)

- [x] Windows + macOS support: platform shell (PowerShell/cmd/bash), per-OS data dirs, case-insensitive path policy
- [x] `ramcp tunnel` — public https URL via Cloudflare quick tunnel, binary auto-download, ephemeral runtime state (never clobbers config), connectivity self-check
- [x] Service install: systemd (Linux) / launchd (macOS) / schtasks (Windows)

## v3.0 — Consolidation (done)

- [x] **Fleet mode removed** — the project is deliberately single-machine.
      The gateway controls the machine it runs on; multi-server orchestration
      is out of scope by owner decision. (The removal also took a real
      security lesson with it: dynamically-omitted schema parameters let the
      SDK silently drop client args — see docs/ai/decisions.md.)
- [x] Webhook notifications on tool events (`ramcp webhook add --url …`), fire-and-forget, deduped, 5s cap
- [x] `ramcp config export | import [--merge]` for backup/restore with host-identity preservation
- [x] AI-oriented documentation: AGENTS.md + docs/ai/

## v3.2+ — Agent Engine roadmap

The post-3.1 roadmap is split into independently verified phases. Each phase
is implemented only after owner approval, then subjected to unit, integration,
regression, adversarial, compatibility, and performance tests appropriate to
the change. No phase publishes or pushes automatically.

- [x] **Phase 0 — Foundation & Architecture:** agent contracts, capability
      model, task lifecycle, context-budget contract, architecture docs, and
      reproducible performance baseline. Baseline: 69 registered tools; 30
      post-warmup registration samples, p50 1.77ms / p95 12.21ms / avg 3.10ms
      in the constrained test environment.
- [x] **Phase 1 — Context Engine:** adaptive verbosity (`minimal` / `balanced` /
      `full`), result compression, duplicate-line/blank-line reduction,
      token-isolated short-lived cache, persistent task memory, snapshots/diffs,
      explicit context budgeting, and observability tools (`context_stats`,
      `context_memory`, `context_snapshot`, `context_diff`, `context_budget`,
      `context_clear`). The engine is project-local under RAMCP's own data
      directory and never touches any external Codebase Memory state.
      Context benchmark: 1,000 JSON-result transformations reduced 3.88 MB to
      2.168 MB (44.12% byte reduction), averaging 0.0479 ms/transformation in
      the constrained test environment.
- [x] **Phase 2 — Capability Router & Tool Efficiency:** authoritative capability
      catalog derived from policy scopes, filtered capability discovery,
      context-cost/latency metadata, read-only parallel batching, capability
      routing helpers, and optional scoped `tools/list` exposure via
      `RAMCP_TOOL_EXPOSURE=scoped`. Empty-scope tokens keep the backward-
      compatible all-tools behavior. Benchmark: 77 built-in tools / 30,802
      response bytes in all-tools mode versus 14 tools / 6,054 bytes for a
      filesystem+system+diagnostics scoped token — 81.8% fewer tools and
      80.3% fewer `tools/list` bytes in the constrained environment.
- [x] **Phase 3 — Task / Workflow / Agent Engine:** durable intent-driven task
      execution with validated dependency graphs, bounded parallelism, retries,
      per-action timeouts, explicit verification hooks, dry-run, supervised
      approval pause/resume, compensation rollback, token-isolated persistence,
      resumable state, and specialized agent profiles (explorer/planner/
      implementer/tester/reviewer/security/deployer). `task` is the orchestration
      entry point; `task_status` remains backward-compatible with the existing
      plan-status tool and now also reports durable workflow tasks. Phase 3
      verification: 15 focused TaskEngine tests + full 28-file / 162-test suite,
      build/lint/audit/diff checks all pass. Task benchmark: 100 three-action
      workflows, p50 19.29ms / p95 50.99ms / avg 21.77ms in the constrained
      environment (including local durable persistence).
- [x] **Phase 4 — Knowledge & Developer Intelligence:** isolated Codebase Memory,
      Context7, Context Mode compatibility, token-isolated project profiles,
      reverse dependency impact analysis, Git intelligence, GitHub repository/issue/PR
      intelligence, and Sentry project/issue intelligence. Dynamic Context7/Codebase
      Memory tools are protected by the explicit `integrations` scope when scoped
      tool exposure is enabled.
- [x] **Phase 5 — Browser & Infrastructure Ecosystem:** headless browser tools
      (`browser_open`, `browser_extract`, `browser_screenshot`) with public-URL SSRF
      protection and policy-allowed screenshot paths; fixed-executable Docker and
      Kubernetes inspection/actions; Cloudflare `cloudflared` status; and a
      non-destructive `infra_probe`. Existing MySQL/PostgreSQL/Redis database tools
      remain the canonical database adapter and were not rewritten. Browser runtime
      is optional (`playwright` or `playwright-core`); infrastructure tools degrade
      cleanly when CLIs are absent.
- [x] **Phase 6 — Automation & Events:** persistent token-isolated automation
      rules, interval/tool/webhook/file/health trigger model, typed conditions,
      bounded action lists, enable/disable/delete lifecycle, authenticated inbound
      webhook triggers, webhook outcomes, path-policy checks, recursion protection,
      and policy/audit/read-only-gated action execution through the normal tool
      wrapper. Persistent mutations use a cross-process lock and rule execution
      uses an atomic per-rule claim to prevent duplicate scheduler execution.
      Verification: 31-file / 176-test suite, cross-process persistence 80/80,
      duplicate execution claim 1/1, authenticated webhook trigger 200 with
      one action execution and recursion suppressed. Automation benchmark: 200
      rules / 100 dispatches, p50 33.63ms / p95 45.82ms / avg 36.16ms.
- [x] **Phase 7 — Security & Autonomous Operations:** bounded security posture
      analysis, centralized autonomy/risk gating, opt-in self-healing with
      persistent token-isolated recovery rules, cooldown/attempt limits, durable
      incidents, and failure-triggered recovery through the normal policy/audit
      execution path. Autonomous mode is disabled by default.
- [x] **Phase 8 — Plugin Isolation & Ecosystem:** out-of-process plugin tool
      bridging, validated/fingerprinted installations, namespaced tool exposure,
      token-scope/read-only gates, Node filesystem permission isolation, Linux
      network namespace + deny-by-default network controls, bounded manifests,
      and fail-closed lifecycle/verification. Registry distribution remains
      intentionally deferred to a future ecosystem layer.
- [x] **Phase 9 — Final Hardening / 4.0:** cross-platform and Linux runtime
      verification, load/crash/security regression testing, dependency audit,
      benchmark/package gates, plugin registry concurrency hardening,
      documentation and stable 4.0 architecture. Final verification: 33 test
      files / 183 tests, build + type check, npm audit (0 vulnerabilities),
      production boot, Codebase Memory isolation 2/2, plugin sandbox/tamper
      tests, concurrent plugin install stress (6 processes / 1 successful
      install / 1 registry entry), and npm pack smoke.

## Under consideration

- [ ] Long-running commands: background jobs + poll (MCP clients time out
      before a 10-minute deploy does)
- [ ] Binary file transfer (current tools are text/base64-oriented)
- [ ] Log follow-mode streaming into the chat
- [ ] WebSocket transport — deferred: no supported client requires it today

## Non-goals

- Multi-server / fleet mode — removed by owner decision; one gateway, one machine.
- Docker images — npm + systemd is the deployment story, deliberately.
- GUI — terminal is the interface for people who run servers.
