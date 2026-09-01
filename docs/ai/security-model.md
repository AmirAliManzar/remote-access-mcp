# Security Model

The gateway hands an AI the keys to a machine. Every design choice below
exists to make that survivable. Read this before touching anything in the
auth, policy, or audit paths.

## Threat model, plainly

The token holder is **trusted** (that's you). The threats are:
1. **Token leakage** → mitigate: no secrets in logs/audit (fingerprints only),
   tight file perms, rotate in one command.
2. **The AI itself** going somewhere you didn't intend → mitigate: path
   sandbox, scope groups, read-only mode, shell opt-in, protected
   services/packages/processes, SSRF walls.
3. **A hostile chat platform or MITM** → mitigate: TLS at the edge
   (Cloudflare/Let's Encrypt), loopback-only bind, timing-safe compares.
4. **Tampering with history** after an incident → the hash chain.

## Layer 1 — Network

- Binds `127.0.0.1` only. Nothing listens publicly but nginx/Cloudflare.
- `ramcp tunnel` (laptops) publishes a temporary https URL via cloudflared;
  the URL dies with the process, is tracked in pid-checked `runtime.json`,
  and self-verifies reachability before promising anything.

## Layer 2 — Authentication

- Two equivalent forms: `Authorization: Bearer <token>` or the token in the
  URL path (`/<token>/mcp`) — the latter because ChatGPT connectors cannot
  set custom headers.
- Compare is **timing-safe** with a length pre-filter (`core/crypto.ts`).
- Token records: expiry (ISO date), per-token rate limit (token bucket,
  burst = rpm/4), revocation is config write + hot reload — a rotated token
  dies mid-conversation.
- Sessions (stateful dialect) are **bound to the token fingerprint** that
  opened them: presenting another token with a stolen session id → 403.

## Layer 3 — Authorization (per token)

`assertToolPermitted()` enforces, in order:

1. **scopes** — empty = every group; else the tool must belong to a listed
   group. Group map is static in `core/policy.ts` (TOOL_SCOPES).
2. **read-only** — per-token or global `ramcp policy readonly on` refuses
   every entry of `MUTATING_TOOLS`.
3. **path sandbox** — only if the tool passes a `target`:

```
resolveReal(path)               # realpathSync; for missing paths, the deepest
                                # existing ancestor is resolved and the
                                # remainder re-attached → symlink escapes collapse
  → in denied_paths?  → refuse  # deny always wins, even inside an allowed root
  → in allowed_paths? → allow
  → else              → refuse  # empty allow-list denies everything
```

Path comparison is case-insensitive on Windows/macOS, separators normalized
(`core/platform.ts`).

**In-chat policy tools can only widen their own token's sandbox** — they
mutate the calling token's record, never another token's.

## Layer 4 — Tool-level guards

| Guard | Tool(s) | Behavior |
|---|---|---|
| Shell opt-in | run_command, kill_process, schedule | refuse unless token `shell_enabled` |
| Protected pids | kill_process | gateway pid, ppid, PID 1 |
| SSRF wall | http_request, web_fetch, port_check | 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 (cloud metadata), 0/8, ::1, fc00::/7, fe80::/10, IPv4-mapped v6, metadata hostnames |
| Git arg whitelist | git | ~45 known verbs; `--upload-pack`/`--exec=` refused; no `;&|`${}`<>` in args |
| SQL single-statement | sqlite_query | one statement; ATTACH/DETACH refused (escape the sandbox via another db file) |
| Unit-name regex | service_*, journal | `[A-Za-z0-9@._-]+` only |
| Protected units | service_action | ssh/sshd/systemd/networkd/dbus/gateway itself/major Windows services |
| Protected packages | package_remove | nodejs/npm/nginx/openssh/systemd/remote-access-mcp |
| Secret masking | secret_scan | matches reported as file:line + type only — never the secret |
| Secret redaction | environment_inspect | pass/secret/token/key/auth/credential vars → `[MASKED]` |
| Schedule floor | schedule_command | ≥60s recurrence; one-shot allowed |

## Layer 5 — Accounting

- **Audit log** (`audit.jsonl`): one line per tool invocation — ts, token
  **fingerprint** (sha256-16, never the secret), tool, redacted args,
  ok/is_error, duration. Each line's `hash = sha256(prev_hash + fields)` →
  deleting or editing any line breaks every hash after it.
  `ramcp audit chain` walks it; exit code 2 on tamper. Args are redacted
  (`pass|secret|token|key|auth` keys → `[REDACTED]`, values capped at 300ch).
- **Webhooks** mirror tool.error/tool.success out to URLs you own —
  fire-and-forget, 5s timeout, identical events deduped within 10s.

## Layer 6 — The audit wrapper itself

`buildServerFor()` monkey-patches `server.registerTool` so **every** handler
is wrapped: errors are caught and converted to `isError` results (a tool
crash must never 500 the transport), then audit + webhooks fire. This is
also the single choke point where a future change would accidentally bypass
accounting — keep it that way.

## Things we refuse to add (non-negotiable)

- No `require()` in `src/` (pure ESM; one slip crash-looped production).
- No native modules in the request path (better-sqlite3 SIGABRT'd the
  stateless loop — audit is plain JSONL now).
- No dynamic schema omission (the SDK silently drops unknown client args;
  that once executed a "remote" command locally — ADR-008).
- No second machine (fleet removed by owner decision — ADR-007).

## If you're adding a tool

Checklist: (1) pick/extend a scope group; (2) decide mutating or read-only
and add to MUTATING_TOOLS if mutating; (3) accept `path`-style targets →
pass them as `target:` to the gate; (4) think about injection (quotes,
metacharacters, second-order effects) and add a guard, not a regex hope;
(5) never log secrets; the audit wrapper redacts args but your *output* is
on you.
