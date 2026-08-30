# Roadmap

The vision: one command turns any server into an AI-controllable machine — securely, transparently, and without heavy dependencies.

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
- [x] **Tamper-evident audit log** — SQLite hash chain, `ramcp audit --verify`, secret redaction
- [x] **`ramcp doctor`** — tokens, port, gateway health, nginx vhost, public URL, audit chain in one pass
- [x] **Hot-reload** — policy changes apply on the next request, no restart
- [x] **Global read-only mode** — kill-switch for all mutating tools
- [x] **SSRF guards** — loopback/private/metadata ranges refused on all fetch tools
- [x] **Injection guards** — git verb whitelist, SQL single-statement + ATTACH block, unit-name validation
- [x] New suites: logs/journal, systemd control, packages, scheduler, security scans, project analysis, planning/snapshots, web_fetch
- [x] 42 tests + CI on Node 18/20/22

## v2.1 — Next

- [ ] `ramcp upgrade` — self-update + service restart
- [ ] Log rotation for `access.log`-style output
- [ ] `--dry-run` for service install (show what would be written)
- [ ] Prometheus `/metrics` endpoint (opt-in)
- [ ] WebSocket transport alongside Streamable HTTP

## v3.0 — Fleet

- [ ] Multi-server mode: one gateway, SSH out to N machines, tools take a `--host` parameter
- [ ] Fleet dashboard: `ramcp fleet status` across all machines
- [ ] Token sharing across machines with per-host policies
- [ ] MCP tool result caching for repeated expensive calls

## Ideas parking lot

- `ramcp config export/import` for backup/restore
- Webhook notifications on audit anomalies (e.g. new token created, read-only violated)
- Pinned-tool aliases: expose a git-command as a narrower custom tool
- Integration recipes: pre-scoped tokens for "deploy my Node app", "restart nginx", common workflows

## Non-goals

- Docker images — npm + systemd is the deployment story, deliberately.
- Windows support — Linux servers are the target; macOS works best-effort.
- GUI — terminal is the interface for people who run servers.
