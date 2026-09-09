# remote-access-mcp

[![npm version](https://img.shields.io/npm/v/remote-access-mcp.svg)](https://www.npmjs.com/package/remote-access-mcp)
[![CI](https://github.com/AmirAliManzar/remote-access-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/AmirAliManzar/remote-access-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Turn any machine into a secure AI-agent-accessible endpoint via the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).

ChatGPT (Developer Mode), Claude, Grok, and any MCP-compatible client connect over HTTPS and securely control your server: read/write files, run shell commands, manage services, query databases, audit everything — all behind per-token permissions.

**Zero Python. Zero Docker. Just Node.js.**

```bash
npm install -g remote-access-mcp
ramcp init
```

## Why

AI assistants are great, but they're sandboxed away from your infrastructure. This gateway flips that: your chatbot *becomes* the ops engineer. "Check why the disk is filling up, fix it, and show me the logs" becomes an actual conversation.

The server binds to `127.0.0.1` only. You put it behind nginx (with Cloudflare or any TLS edge in front) and expose exactly one HTTPS endpoint to the world. Every request carries a token — as an `Authorization: Bearer` header or embedded in the URL path (`/<token>/mcp`) for clients like ChatGPT's connectors that can't set custom headers.

## Parallel execution & background workers

Remote Access MCP includes a bounded local worker pool for long-running or parallel operations. Use `run_background` for asynchronous commands and `run_parallel` for multiple commands. Jobs have persistent metadata, output capture, cancellation, timeouts, retry limits, and per-token ownership.

## Safe operations

- Binary-safe `upload_file` / `download_file` with size limits and SHA-256 verification.
- Approval-required shell mode and command allowlists.
- Managed filesystem change sets with durable pre-mutation capture, create/delete tracking, resumable rollback, and atomic per-path restore.
- Token roles: `auditor`, `developer`, `deployer`, `admin`.

## Diagnostics & extensibility

- Structured system/service diagnostics and persistent health watchers with webhook alerts.
- MySQL/PostgreSQL/Redis query and schema tools using credentials held in environment variables.
- MCP Resources and Prompts for operational context.
- Isolated local plugin lifecycle: manifests are validated and fingerprinted, plugin tools are namespaced, and installed plugins run out-of-process behind Node's filesystem permission model plus a Linux network sandbox. Plugin access requires the `plugins` scope; untrusted or unverifiable plugins are skipped fail-closed.

## Install

### Any machine with Node.js 18+ — Linux, macOS, or Windows

The core gateway supports Node.js 18 and newer. Optional MCP integrations may have higher runtime requirements; on Node.js 18 they are skipped when their packages cannot run, while the core gateway remains available.

```bash
npm install -g remote-access-mcp
ramcp init
```

### One-liner (Ubuntu/Debian servers)

```bash
curl -fsSL https://raw.githubusercontent.com/AmirAliManzar/remote-access-mcp/main/install.sh | bash
ramcp init
```

### Manual

```bash
npm install -g remote-access-mcp
ramcp init
```

## Quick start

On a **server** with a domain:

```bash
ramcp init                          # config + first token
ramcp policy allow /srv/myapp       # what the AI may touch
ramcp policy shell on               # let it run commands (optional)
ramcp service install --domain mcp.example.com   # systemd + nginx
ramcp doctor                        # verify everything end-to-end
ramcp url                           # connector URL for your chatbot
```

On a **laptop or desktop** (no domain, no port forwarding):

```bash
ramcp tunnel
# → downloads cloudflared on first run (no account needed),
#   prints a public https URL like https://random-words.trycloudflare.com
# `ramcp url` in another terminal shows the live connector link.
```

Works the same on Windows, macOS, and Linux — PowerShell/cmd on Windows,
launchd on macOS, systemd on Linux for the autostart service.

## Commands

| Command | Description |
|---|---|
| `ramcp init` | Generate config + first token. Safe to re-run. |
| `ramcp start [--read-only]` | Run in the foreground. |
| `ramcp url [token]` | Connector URL for a chatbot. |
| `ramcp doctor` | One-pass diagnosis: tokens, port, gateway, nginx, public URL, audit chain. |
| `ramcp status` | Service + config summary. |
| `ramcp token list [--json]` | All tokens (fingerprints only). |
| `ramcp token add --name N` | Create a scoped token — see options below. |
| `ramcp token rotate [name]` | Rotate a token (old one dies instantly). |
| `ramcp token revoke name` | Delete a token. |
| `ramcp policy [token]` | Show/set path policy, shell flag. |
| `ramcp policy readonly on` | Global kill-switch for ALL mutating tools. |
| `ramcp audit [--tool T]` | Query the audit log. `--verify` checks the hash chain. |
| `ramcp service install` | systemd unit (+ nginx vhost with `--domain`). |
| `ramcp service logs -f` | Tail gateway logs. |
| `ramcp schedule list` | List scheduled tasks. |
| `ramcp webhook add --url URL --events EVENTS` | Add a webhook subscription. |
| `ramcp webhook list` | List configured webhooks. |
| `ramcp webhook on URL` / `off URL` | Enable or disable a webhook. |
| `ramcp webhook remove URL` | Remove a webhook. |
| `ramcp config export --out FILE` | Export configuration and credentials for backup. |
| `ramcp config import FILE [--merge]` | Restore or merge a configuration backup. |
| `ramcp tunnel` | Start a temporary public tunnel. |

### `token add` options

Role and shell controls can be combined with `--role auditor|developer|deployer|admin`, `--commands git,npm` and `--approval required|auto`. Roles act as permission ceilings; explicit token scopes can further restrict a role.

```bash
ramcp token add --name chatgpt \
  --paths /srv/app \        # allowed directories (symlink-safe)
  --deny /srv/app/.env \    # explicitly denied (deny always wins)
  --shell \                 # allow shell commands (default: off)
  --scopes filesystem,git \ # limit to tool groups (default: all)
  --read-only \             # refuse every mutating tool
  --rpm 30 \                # max requests per minute
  --expires 2026-12-31      # auto-expiry
```

Example — a token that can only read files, never write or execute:

```bash
ramcp token add --name auditor --paths /srv --scopes filesystem --read-only
```

## Connecting your chatbot

### ChatGPT (Developer Mode → Connectors)

```
https://your-domain.com/<token>/mcp
```

Get it ready-made: `ramcp url`

### Claude / any MCP client with header support

Endpoint `https://your-domain.com/mcp` + header `Authorization: Bearer <token>`

## Tools (101 built-in operational tools, plus optional integration tools)

The built-in tool count is stable. Optional MCP integrations can add additional namespaced tools when their upstream packages are available.

**Filesystem** (7) `list_directory` `read_file` (offset/limit) `write_file` `edit_file` `delete_path` `search_code` `file_info`

**Shell** (3) `run_command` (opt-in, timeout, output cap) `process_list` `kill_process` (refuses gateway/PID 1)

**System** (3) `system_info` `disk_usage` `network_interfaces`

**HTTP** (3) `http_request` `port_check` `web_fetch` — all SSRF-guarded: loopback, private ranges, and cloud metadata endpoints are refused

**Git** (1) `git` — verb-whitelisted; option injection (`--upload-pack`) and shell metacharacters blocked

**SQLite** (2) `sqlite_query` `sqlite_schema` — single-statement, ATTACH blocked

**Logs** (3) `tail_logs` `search_logs` `journal` (unit name validated)

**Services** (2) `service_status` `service_action` — protected units (ssh, gateway itself, targets) refused

**Packages** (3) `package_list` `package_install` `package_remove` (refuses nodejs/nginx/ssh)

**Scheduler** (3) `schedule_command` `list_scheduled_tasks` `cancel_scheduled_task` — min 60s intervals, shell-token-gated

**Security** (2) `secret_scan` (10 credential patterns, masked output) `port_scan_local`

**Project** (2) `analyze_project` `project_health_check`

**Planning** (4) `create_task_plan` `task_status` `workspace_snapshot` `rollback_changes` — snapshot before risky edits, roll back atomically

**Policy** (4) `list_allowed_paths` `allow_path` `deny_path` `shell_enabled` — each token manages only its own sandbox

**Operations** (2) `environment_inspect` `nginx_inspect`

**Browser** (3) `browser_open` `browser_extract` `browser_screenshot` — optional Playwright runtime; public-URL SSRF guard; screenshots must stay inside the token path sandbox

**Infrastructure** (9) `infra_probe` `docker_ps` `docker_inspect` `docker_logs` `docker_action` `kubernetes_get` `kubernetes_describe` `kubernetes_logs` `cloudflare_status` — fixed executables and validated arguments; missing CLIs degrade cleanly

**Database** (2) `database_query` `database_schema` — MySQL/PostgreSQL/Redis support already provided by the existing adapter

## Automation & Events

Automation rules are persistent, token-isolated workflows triggered by intervals or tool/webhook/file/health events. They support typed conditions, bounded action lists, manual triggering, enable/disable/delete lifecycle, execution counters, and webhook outcome notifications. Every action is executed through the normal token policy/read-only/audit wrapper; automation cannot invoke control-plane, approval, or plugin lifecycle tools. File triggers are constrained by the owner's path policy, payloads are bounded, and recursive automation chains are capped.

For external events, an authenticated webhook can POST to `/<token>/automation/webhook` with a JSON body such as `{"type":"deploy.finished","data":{"service":"api"}}`. The token selects the owner's rules; the token is never copied into the event payload. Scheduler/file/health execution is persistent and protected by a cross-process execution claim so multiple gateway processes do not intentionally execute the same rule concurrently.

## Security & Autonomous Operations

Phase 7 adds `security_analysis` and `autonomy_check` plus bounded self-healing
through `recovery_rule_create`, `recovery_rule_list`, `recovery_incidents`, and
`recovery_trigger`. Recovery state is persistent and token-isolated, with
maximum attempts and cooldowns. Autonomous operations are **disabled by
default** and require `RAMCP_AUTONOMOUS=1`; high-risk and critical recovery
also require their respective explicit environment flags. Recovery actions use
the same policy, scope, read-only, audit, and context-wrapped tool execution as
normal requests, and cannot invoke approvals, plugins, automation lifecycle,
or recovery lifecycle tools.

## Plugin Isolation & Ecosystem

Plugins are local, explicit installations. A plugin directory must contain a
`manifest.json` with a semver-like `version` and a relative `entry` exporting
`register(server, ctx)`. The gateway validates the tree, rejects symlinks and
oversized packages, stores a SHA-256 fingerprint, and verifies that fingerprint
before every child-process start. Plugin tools are exposed as
`plugin_<name>__<tool>` and require the `plugins` token scope; declared plugin
scopes must also be available to the token.

Example manifest:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "entry": "index.js",
  "permissions": ["fs.write"],
  "scopes": ["filesystem"]
}
```

Runtime permissions are deliberately small: `fs.read` permits reads inside
the plugin directory, `fs.write` permits writes only under the plugin's
`data/` directory, and `process` permits child processes. Network access is
disabled by default. On Linux the child also gets a separate network namespace
and deny-by-default network filter. If the required sandbox is unavailable,
the plugin is skipped unless `RAMCP_PLUGIN_UNSANDBOXED=1` is explicitly set by
the operator. Plugin calls are short-lived and have a bounded execution time;
there are no persistent plugin worker processes.

The plugin host receives no token secret and no gateway mutation API. This is
an intentional break from the old in-process `trusted: true` model: declaring
trust inside a manifest is not considered a security boundary.

## Webhooks

Get notified when tools run (or fail) — incident bots, Slack relays, anything that accepts a POST:

```bash
ramcp webhook add --url https://hooks.example.com/ramcp --events tool.error
ramcp webhook list
```

Fire-and-forget: a dead endpoint never delays a tool call (5s cap, deduped within 10s).

## Backup & restore

```bash
ramcp config export --out backup.json     # full snapshot, 0600 perms — contains live tokens!
ramcp config import backup.json           # replace
ramcp config import backup.json --merge   # union: keeps local identity, adds new tokens/hosts/hooks
```

> ⚠️ **Security warning:** configuration exports contain active authentication tokens. Treat backup files as secrets: never commit them to Git, upload them to issue trackers, or share them publicly. Store them with restricted permissions and rotate tokens if a backup is exposed.

## Security model

- **Loopback only.** The gateway listens on `127.0.0.1` — unreachable directly from the network.
- **Timing-safe token auth** on every request; tokens never appear in logs (audits store fingerprints).
- **Per-token sandbox.** Path policy resolves symlinks and collapses `..` before checking; deny always wins.
- **Per-token scopes + read-only + rate limit + expiry.** Least privilege by construction.
- **SSRF guards** on all outbound fetch tools — the AI can't reach your metadata endpoints or internal services.
- **Injection guards.** git verbs whitelisted, SQL single-statement, ATTACH blocked, unit names validated.
- **Tamper-evident audit.** Every tool invocation → append-only JSONL with a hash chain; `ramcp audit --verify` detects deletions/edits. Secrets in arguments are redacted before storage.
- **Hot-reload.** Policy edits apply on the next request — no restart, no downtime.
- **Global read-only** kill-switch: `ramcp policy readonly on`.

You provide TLS (nginx + Cloudflare/Let's Encrypt). The gateway speaks plain HTTP on loopback, like every other loopback service.

## FAQ

**Is exposing a shell to an AI safe?**
It's exposing a shell to *you*, via the AI as the interface. Least-privilege tokens, scoped tools, off-by-default shell, tamper-evident audit, and a read-only mode give you dials that raw SSH doesn't.

**Stateless sessions?**
Each request builds a fresh MCP transport. No session state to corrupt, trivially scalable, and it's the mode ChatGPT's connector flow works best with.

**Where does config live?**
`~/.config/remote-access-mcp/config.json` (0600) + `audit.db` + `schedule.json` alongside it.

## Development

```bash
git clone https://github.com/AmirAliManzar/remote-access-mcp
cd remote-access-mcp
npm ci && npm run build && npm test
```

The test suite covers policy enforcement, authentication, transport compatibility (stateful, stateless, legacy SSE), cross-platform behavior, tunnel wiring, webhooks, configuration backup, CLI lifecycle, and crash regressions. CI runs on Node.js 18, 20, and 22.

## License

MIT — see [LICENSE](LICENSE).

---

📚 [README فارسی](README.fa.md) | [Roadmap](ROADMAP.md) | [Security Policy](SECURITY.md) | [Changelog](CHANGELOG.md) | [Contributing](CONTRIBUTING.md)

## Capability Router & Context Efficiency

Phase 2 adds a capability catalog and discovery layer for agent clients:
`capability_discover` returns only capabilities authorized for the current
token and includes context-cost and latency hints. `capability_batch` runs up
to eight independent read-only calls in parallel and rejects mutating actions.

For tokens with explicit scopes, `RAMCP_TOOL_EXPOSURE=scoped` can also reduce
`tools/list` itself to the authorized tool set. The default remains `all` for
backward compatibility. In the built-in benchmark, a scoped token exposed
14 tools instead of 77 and reduced the serialized `tools/list` response by
80.3% (30,802 → 6,054 bytes).

## Task / Workflow / Agent Engine

Phase 3 adds durable orchestration through the `task` tool. A task contains a
validated action graph and can run independent actions in parallel while
respecting dependencies, retries, per-action timeouts, verification hooks,
dry-run mode, and compensation rollback. `supervised` tasks pause before
mutating actions and resume through `task_approve`; interrupted/failed tasks
can be resumed with `task_resume` because task state is persisted under RAMCP's
own data directory and isolated by token.

Specialized profiles are available through `agent_profiles` and optional action
assignment: `explorer`, `planner`, `implementer`, `tester`, `reviewer`,
`security`, and `deployer`. Profiles constrain capability scopes and autonomy;
they are deterministic execution roles, not hidden model instances. The
existing `task_status` tool remains backward compatible with plan tracking and
also reports workflow tasks.

## Developer Intelligence

Phase 4 adds a compact developer-intelligence layer without replacing the existing policy core:

- `project_profile` / `project_profile_list` / `project_profile_set` keep per-token workspace knowledge under RAMCP's own data directory.
- `impact_analysis` builds a lightweight reverse dependency graph for changed source files.
- `git_intelligence` summarizes repository state, history, diff statistics, branches, and remotes without permitting arbitrary Git verbs.
- `github_repo`, `github_issues`, and `github_pull_request` provide read-only GitHub intelligence when `GITHUB_TOKEN` or `GH_TOKEN` is configured.
- `sentry_projects`, `sentry_issues`, and `sentry_issue` provide read-only Sentry intelligence when `SENTRY_AUTH_TOKEN` is configured.
- `developer_context_status` reports the Codebase Memory isolation contract, Context7 proxy, and Context Mode's local/client-side role.

GitHub and Sentry credentials are read only from environment variables and are never returned by these tools. Dynamic Context7 and Codebase Memory tools can be exposed to scoped tokens only through the explicit `integrations` scope.

## Optional MCP integrations

Remote Access MCP can expose selected developer-context MCPs as namespaced tools:

- **Context7** — proxied into the gateway as namespaced tools such as `context7_resolve-library-id` and `context7_query-docs`. The MIT-licensed `@upstash/context7-mcp` package is bundled as a normal dependency. A `CONTEXT7_API_KEY` environment variable can be supplied for higher limits/private repositories.
- **Codebase Memory** — the MIT-licensed `codebase-memory-mcp` package is integrated as namespaced `codebase_memory_*` tools when its optional package is available. Set `RAMCP_ENABLE_CODEBASE_MEMORY=0` to disable it. Each Remote Access MCP instance uses a dedicated Codebase Memory runtime, home, cache, data directory, runtime directory, and service identity; it never reuses another service's Codebase Memory state. Set `RAMCP_CODEBASE_ROOT` to the repository this gateway instance should expose; `index_repository` is additionally restricted to that root.
- **Context Mode** — shipped as an optional local dependency only. It is a client/plugin-side context optimization layer and is **not proxied as a hosted service** because its Elastic License 2.0 prohibits providing the software as a hosted or managed service.

Integrations are loaded before the MCP transport connects, so the initial `tools/list` includes them when the upstream MCP is available. If an optional integration cannot start, the core Remote Access MCP remains available and the integration is omitted with a diagnostic message.

### Context Mode local setup

The `context-mode` package is intentionally kept as an optional dependency. Install Remote Access MCP locally, then configure the detected coding agent to run the local `context-mode` executable according to the upstream Context Mode documentation. Do not expose its MCP server through a Remote Access MCP HTTP endpoint.

### Tunnel providers (4.1)

`ramcp tunnel` uses Cloudflare Quick Tunnel by default. You can select a provider explicitly or let RAMCP fall back in order:

```bash
ramcp tunnel --provider cloudflare
ramcp tunnel --provider pinggy
ramcp tunnel --provider localhostrun
ramcp tunnel --provider auto
```

`auto` tries providers sequentially and keeps only the first successful tunnel alive. Provider support is intentionally ephemeral: it does not alter `public_host` or the existing production endpoint. Quick Tunnel and other free tunnel services are best-effort and subject to their own availability, limits, and terms.
