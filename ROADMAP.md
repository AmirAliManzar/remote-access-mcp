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

## v3.0 — Fleet (done)

- [x] **Multi-server mode**: one gateway, SSH out to N machines — `ramcp fleet add --name web1 --host deploy@10.0.0.5 --tools shell,fs`
- [x] Remote-capable tools: run_command, process_list, read_file, write_file, delete_path, search_code, file_info, list_directory, tail_logs, search_logs, journal, service_status, service_action, package_list — all take an optional `host` parameter
- [x] Per-host tool allowlists (shell/fs/logs/services/packages) — enforced before any SSH attempt
- [x] `ramcp fleet list | add | remove | edit | test | status`
- [x] Webhook notifications on tool events (`ramcp webhook add --url …`), fire-and-forget, deduped, 5s cap
- [x] `ramcp config export | import [--merge]` for backup/restore with host-identity preservation
- [x] Fleet file writes pipe over stdin (base64) — no temp files, no heredocs

## v3.x — Under consideration

- [ ] WebSocket transport alongside Streamable HTTP — deferred: no client we
      support (ChatGPT, Grok, Claude) requires it today, and the streamable
      transport already covers the same ground. Will revisit when a real
      client asks.
- [ ] Tool result caching for repeated expensive calls — deferred: the
      stateless transport makes caching semantics ambiguous (per token?
      per session? TTL from where?), and no user has hit a bottleneck
      that caching would fix. Premature.

## Ideas parking lot

- Pinned-tool aliases: expose a git-command as a narrower custom tool
- Integration recipes: pre-scoped tokens for "deploy my Node app", "restart nginx", common workflows
- Per-host policy paths (fleet fs scoped to specific remote directories)

## Non-goals

- Docker images — npm + systemd is the deployment story, deliberately.
- Windows support — Linux servers are the target; macOS works best-effort.
- GUI — terminal is the interface for people who run servers.
