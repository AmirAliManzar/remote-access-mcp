# AGENTS.md — Guide for AI Coding Agents

This file is the entry point for any AI agent (Claude Code, Cursor, opencode,
Windsurf, etc.) working in this repository. Read it fully before touching code.

**Deep documentation lives in [`docs/ai/`](docs/ai/)** — go there next:

| File | What it covers |
|---|---|
| [`docs/ai/architecture.md`](docs/ai/architecture.md) | Module map, request lifecycle, data flow |
| [`docs/ai/tools-and-cli.md`](docs/ai/tools-and-cli.md) | Every built-in tool (45) and CLI command, with schemas and policy gates |
| [`docs/ai/security-model.md`](docs/ai/security-model.md) | Auth, policy engine, guards, audit chain — read before security-adjacent changes |
| [`docs/ai/transport-compatibility.md`](docs/ai/transport-compatibility.md) | The three MCP dialects we serve and why (hard-won lessons) |
| [`docs/ai/decisions.md`](docs/ai/decisions.md) | Architecture Decision Records, including the fleet removal |

## What this project is

`remote-access-mcp` turns **one machine** (a server, a laptop, a desktop) into
an endpoint an AI chatbot can operate over the [Model Context Protocol](https://modelcontextprotocol.io).
ChatGPT, Grok and Claude connectors drive the machine's filesystem, shell,
services, logs and packages through a per-token security policy.

**One gateway = one machine. By design.** Multi-server orchestration ("fleet
mode") was implemented and then removed (v3.0.0) — see
[decisions.md ADR-007](docs/ai/decisions.md). If a task asks you to add it
back, stop and confirm with the owner first.

## The 30-second mental model

```
Chatbot (ChatGPT/Grok/Claude)
   │  HTTPS via Cloudflare (TLS) / or quick tunnel on laptops
   ▼
nginx (port 80, SSE-tuned)         ── only on servers with a domain
   ▼
express gateway (127.0.0.1:8765)   ── node dist/server/run.js
   ├─ authenticate token (URL-path or Bearer header)
   ├─ per-token policy: scopes + paths + shell flag + read-only + rpm + expiry
   ├─ per-request McpServer build → tools re-registered fresh (hot-reload)
   ├─ audit wrapper → JSONL hash chain + webhook notifications
   ▼
the machine: fs, shell, systemd, journalctl, apt/npm, git, sqlite …
```

- Server speaks **both** Streamable HTTP (stateless + stateful) **and** the
  legacy 2024-11-05 SSE transport, on **both** `/mcp` and `/sse` paths.
- Config: `~/.config/remote-access-mcp/` (Linux), `AppData/Roaming` (Win),
  `Library/Application Support` (mac). Live tunnel URL goes to `runtime.json`,
  never config.

## Ground rules for changes

1. **TypeScript strict, ESM-only, zero `require()`** in `src/` — a `require()`
   slipped past vitest once and crash-looped production for a day (ADR-004).
2. **Keep native dependencies isolated.** The audit log is plain JSONL and
   does not depend on native bindings (ADR-005). The optional `sqlite_*` tools
   use `better-sqlite3` only when SQLite functionality is invoked.
3. **Tests must be hermetic** — build gateway state explicitly; never read the
   host's real config. A test suite that leaks production config will fail
   whenever the service is running (ADR-006).
4. **Run `npm test` before any publish.** CI runs Node 18/20/22; the exact test count may change as regression coverage grows.
5. **Schema parameters must never be conditionally omitted** — the SDK
   silently drops client args that aren't in the schema, which once turned a
   "remote" command into a local execution (ADR-008).
6. Commits: conventional, small, one concern each. This repo's history is
   read as documentation (see `docs/ai/decisions.md`).

## Commands

```bash
npm run build      # tsc → dist/
npm test           # vitest, 107 tests
npm run dev        # tsx watch (local only)
ramcp doctor       # after deploying: full-chain health check
```

Deploy flow: build → test → `npm publish` → `npm i -g remote-access-mcp@latest`
on the server → `systemctl restart remote-access-mcp` → verify via
`ramcp doctor` + a ChatGPT-dialect initialize POST.
