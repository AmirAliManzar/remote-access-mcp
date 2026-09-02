# Tools & CLI Reference

Complete inventory of what the gateway exposes, as of v3.0.2.
Counts: **45 built-in tools / 16 suites**. Optional MCP integrations may add additional namespaced tools. CLI commands are documented by group below.

Every tool handler runs inside the audit wrapper (app.ts): execution is
timed, arguments redacted, outcome appended to the hash chain, webhooks
notified. A thrown `PolicyError`/`ScopeError` becomes a normal `isError`
result — never a 500.

## Permission gate (read this first)

`assertToolPermitted({ tool, scopes, readOnly, policy?, target? })` in
`core/policy.ts` — three checks, in order:

1. **scopes** — token's `scopes[]` empty = all groups; otherwise tool must
   be in a listed group (group map in `TOOL_SCOPES`).
2. **readOnly** — token or global read-only refuses `MUTATING_TOOLS`.
3. **policy paths** — if `target` given: resolveReal() (symlinks collapsed,
   deepest existing ancestor for not-yet-existing files) → deny-list wins →
   must be inside an allow-list entry.

Scope groups: `filesystem shell system http git sqlite policy logs services
packages schedule security project planning formatting documents ops web`.
(`ramcp scopes` prints them with member tools.)

## Suites

### filesystem (7) — policy-gated on every path
| Tool | Notable |
|---|---|
| `list_directory` | 2000-entry cap |
| `read_file` | `offset`/`limit` line windows |
| `write_file` | mkdir option |
| `edit_file` | exact-text replace, `all` flag |
| `delete_path` | rm -rf — destructive, policy-gated |
| `search_code` | recursive regex, skips .git/node_modules |
| `file_info` | stat essentials |

### shell (3) — behind token `shell_enabled`
| Tool | Notable |
|---|---|
| `run_command` | platform shell via `shellCommand()`; ≤600s; 60KB output cap; cwd policy-gated |
| `process_list` | ps (POSIX) / Get-Process (Win) |
| `kill_process` | refuses gateway pid, ppid, PID 1 |

### system (3)
`system_info` · `disk_usage` (df / Get-Volume) · `network_interfaces` — all
cross-platform, no gates (read-only host facts).

### http (3) — SSRF-guarded
`http_request` · `port_check` · `web_fetch` — loopback/private/link-local
(169.254.0.0/16 incl. cloud metadata) refused; IPv4-mapped IPv6 too.

### git (1)
`git` — args validated: verb must match a whitelist (~45 verbs, no
`upload-pack`/`exec=`), no shell metacharacters in any arg; `repo_path`
policy-gated.

### sqlite (2) — policy-gated on db_path
`sqlite_query` — single statement only, ATTACH/DETACH refused, SELECT/WITH/
PRAGMA/EXPLAIN return rows, others report changes. `sqlite_schema`.

### logs (3) — policy-gated paths
`tail_logs` (1MB tail read) · `search_logs` (regex + context) · `journal`
(unit-name regex validated; journalctl / mac `log show` / Get-WinEvent).

### services (2)
`service_status` · `service_action` — `PROTECTED_UNITS` regex refuses ssh,
the gateway itself, dbus/networkd/WinDefend etc. Unit names regex-validated.

### packages (3)
`package_list` / `package_install` / `package_remove` — manager auto-detected
(apt / brew / winget / choco / npm); `package_remove` refuses
nodejs/npm/nginx/openssh/systemd/remote-access-mcp.

### schedule (3)
`schedule_command` (one-shot ISO time or recurring ≥60s; requires shell
token) · `list_scheduled_tasks` · `cancel_scheduled_task`. File-backed
(`schedule.json`), a 30s in-process ticker executes them.

### security (2)
`secret_scan` — 10 credential patterns (keys, AWS, GitHub, Slack, npm,
bearer, connection-string passwords); **output is masked**, only
file:line + type. `port_scan_local` — ss / lsof / Get-NetTCPConnection.

### project (2)
`analyze_project` (files/LOC/manifests/entry points, depth-capped walk) ·
`project_health_check` (git dirty, README presence, TODO density).

### planning (4)
`create_task_plan` · `task_status` (mark steps done) · `workspace_snapshot`
(content-addressed file copies) · `rollback_changes` (atomic restore).
Snapshot/rollback are in `MUTATING_TOOLS`.

### web (1)
`web_fetch` — SSRF-guarded public fetch, UA-tagged, size-capped.

### ops (2)
`environment_inspect` — env vars, secrets masked, long values truncated.
`nginx_inspect` — read-only; site names regex-validated (no traversal);
`nginx -T` summary or per-site config.

### policy (4) — token manages only its own sandbox
`list_allowed_paths` · `allow_path` · `deny_path` · `shell_enabled`. Mutations
persist via `saveConfig` and hot-reload; they cannot touch other tokens.

## New operational tools

### Jobs / workers
- `run_background` — asynchronous shell execution through a bounded worker pool
- `run_parallel` — queue multiple commands for bounded parallel execution
- `job_status` / `job_output` / `job_list` / `job_cancel` — inspect and control jobs

### Transfers / safety
- `upload_file` / `download_file` — binary-safe transfer with SHA-256
- `approval_decide` — approve or reject sensitive shell operations
- `change_set_begin` / `change_set_add` / `change_set_status` / `change_set_commit` / `change_set_rollback`

### Diagnostics / data
- `system_diagnostics` / `diagnose_service`
- `health_watch` / `health_status` / `health_stop`
- `database_query` / `database_schema`

### MCP context / extensibility
- Resources: system, services, network, projects and audit
- Prompts: diagnose, deploy, security audit and project inspection
- `plugin_list` / `plugin_install` / `plugin_remove`

## CLI (`ramcp`)

| Command | Subcommands / flags | Notes |
|---|---|---|
| `init` | `--paths a,b` | creates config + default token; re-run safe |
| `start` | `--tunnel --read-only --host --port` | foreground |
| `tunnel` | — | gateway + public URL; runtime state; self-checks reachability |
| `url` | `[name]` | live tunnel URL wins, else public_host/local |
| `token` | `add --name --paths --deny --scopes --shell --read-only --rpm --expires` · `list [--json]` · `show [--full]` · `rotate` · `revoke` | last token can't be revoked |
| `policy` | `allow <p…>` · `deny <p…>` · `shell on/off` · `scopes <groups|all>` (all `--token`) · `readonly on/off` (global) | multi-path, space-separated |
| `scopes` | — | group → tools map |
| `audit` | `--tool --since --limit --json` · `chain` | chain verifies hash chain, exit 2 on tamper |
| `doctor` | — | platform, config, tokens, gateway, service, tunnel, public, audit |
| `service` | `install [--domain] [--tunnel] [--dry-run]` · `uninstall` · `logs [-f]` · `status` | systemd / launchd / schtasks by OS |
| `schedule` | `list [--json]` | |
| `upgrade` | `--dry-run` | npm self-update + right restart per OS |
| `status` | — | incl. live runtime state |
| `version` | — | |
| `config` | `show` · `export [--out]` · `import FILE [--merge]` | export 0600, contains live tokens; merge preserves local identity |
| `webhook` | `add --url --events` · `list` · `on/off URL` · `remove URL` | events: `tool.error`, `tool.success`, `*` |
| ~~`fleet`~~ | — | **removed in v3.0.0** — unknown command now |

### Config file shape (v3)

```jsonc
{
  "host": "127.0.0.1", "port": 8765, "public_host": "mcp.example.com",
  "mcp_path": "/mcp", "mcp_path_aliases": ["/sse"],
  "log_level": "info",
  "audit": { "enabled": true, "db_path": "…/audit.jsonl" },
  "read_only": false,
  "tunnel": { "provider": "cloudflare", "auto_start": false },
  "webhooks": [{ "url": "…", "events": ["tool.error"], "enabled": true }],
  "tokens": [{
    "id": "…", "name": "default", "token": "…", "created": "ISO",
    "expires": "ISO?", "scopes": [], "read_only": false,
    "max_requests_per_minute": 60?, "shell_enabled": true,
    "allowed_paths": ["…"], "denied_paths": []
  }]
}
```

Env overrides (tests, minimal deploys): `RAMCP_TOKEN RAMCP_HOST RAMCP_PORT
RAMCP_PUBLIC_HOST RAMCP_SHELL RAMCP_ALLOWED_PATHS RAMCP_DENIED_PATHS`
(legacy `DANA_*` still honored). `SSH_BIN` existed for fleet tests — gone.
