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

## v3.0 — Consolidation (current)

- [x] **Fleet mode removed** — the project is deliberately single-machine.
      The gateway controls the machine it runs on; multi-server orchestration
      is out of scope by owner decision. (The removal also took a real
      security lesson with it: dynamically-omitted schema parameters let the
      SDK silently drop client args — see docs/ai/decisions.md.)
- [x] Webhook notifications on tool events (`ramcp webhook add --url …`), fire-and-forget, deduped, 5s cap
- [x] `ramcp config export | import [--merge]` for backup/restore with host-identity preservation
- [x] AI-oriented documentation: AGENTS.md + docs/ai/

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
