# Roadmap

The vision: one command turns any server into an AI-controllable machine — securely, transparently, and without heavy dependencies.

## v1.0 — Core gateway (current)

- [x] MCP server over Streamable HTTP (stateless), Node.js + TypeScript
- [x] Dual auth: `Authorization: Bearer` header or `/<token>/mcp` URL path
- [x] Filesystem tools (7) with allow/deny path policy engine
- [x] Shell tools (3) behind an opt-in flag
- [x] System tools (3): info, disk usage, network interfaces
- [x] HTTP tools (2): outbound request, port check
- [x] Git tool (1): full porcelain wrapper
- [x] SQLite tools (2)
- [x] Policy tools (4): manage access from the chatbot itself
- [x] CLI (`ramcp`): init, start, url, token rotate, policy, service, status
- [x] systemd service + nginx vhost installer
- [x] One-liner install script (`install.sh`)
- [x] npm package: `remote-access-mcp`

## v1.1 — Convenience

- [ ] `ramcp doctor` — diagnose token, port, nginx, DNS in one pass
- [ ] `ramcp logs` — journalctl wrapper with sensible defaults
- [ ] Config file hot-reload (no restart needed for policy changes)
- [ ] `--json` output mode on every CLI command (script-friendly)

## v1.2 — Safety net

- [ ] Audit log: every tool invocation recorded (who/what/when/exit code) to a SQLite file
- [ ] `ramcp audit` command to query it
- [ ] Rate limiting per token
- [ ] Read-only mode (`ramcp start --read-only`) — all mutating tools refuse

## v2.0 — Multi-server

- [ ] Multiple named tokens, each with its own policy + shell flag
- [ ] `ramcp token add --paths /srv/foo --no-shell` style provisioning
- [ ] Expiry dates on tokens (JWT-style claims, local verification)
- [ ] A dashboard? Only if there's demand. CLI-first philosophy.

## Non-goals

- Docker images — npm + systemd is the deployment story, deliberately.
- Windows support — Linux servers are the target; macOS works best-effort.
- GUI — terminal is the interface for people who run servers.
