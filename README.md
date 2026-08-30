# remote-access-mcp

Turn any Linux server into an AI-agent-accessible machine via the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).

ChatGPT (Developer Mode), Claude, Grok, and any MCP-compatible client connect over HTTPS and securely control your server: read/write files, run shell commands, inspect system state, query SQLite databases, work with git — all behind a single bearer token.

**Zero Python. Zero Docker. Just Node.js.**

```bash
npm install -g remote-access-mcp
ramcp init
```

## Why

AI assistants are great, but they're sandboxed away from your infrastructure. This gateway flips that: your chatbot *becomes* the ops engineer. "Check why the disk is filling up on the server" or "deploy the new branch and tail the logs" become actual conversations.

The server binds to `127.0.0.1` only. You put it behind nginx/Caddy (with Cloudflare or any TLS edge in front) and expose exactly one HTTPS endpoint to the world. Every request must carry your token — either as `Authorization: Bearer <token>` header or embedded in the URL path (`/<token>/mcp`) for clients like ChatGPT's custom connectors that can't set custom headers.

## Install

### One-liner (any Ubuntu/Debian server)

```bash
curl -fsSL https://raw.githubusercontent.com/amiralimanzar/remote-access-mcp/main/install.sh | bash
```

Installs Node.js (if missing) via NodeSource, then the package globally. Then run:

```bash
ramcp init
```

### Manual

```bash
npm install -g remote-access-mcp
ramcp init
```

## Quick start

```bash
$ ramcp init

  ___                        _____
 | _ \__ _ __ _ ___ _ _   |_   _|__ _ _ _ __ _ ___
 |   / _` / _` / -_) '_|    | |/ - \ '_| '_/ _` / -_)
 |_|_\__,_\__, \___|_|      |_|\___/_| |_| \__,_\___|
          |___/         remote-access-mcp v1.0.0

✔ Config written to /root/.config/remote-access-mcp/config.json
✔ Token generated: 6kX9mQ... (stored in config, never shown again in full)
✔ Test the server:  ramcp start --dry-run

Next steps:
  1. ramcp start                      # run in foreground
  2. ramcp service install            # systemd unit + nginx vhost (recommended)
  3. ramcp url                        # show the connector URL for your chatbot
```

## Commands

| Command | Description |
|---|---|
| `ramcp init` | Generate config + token. Safe to re-run. |
| `ramcp start` | Run the gateway in the foreground. |
| `ramcp url` | Print the MCP endpoint URL for chatbot connectors. |
| `ramcp token rotate` | Generate a new token (old one stops working immediately). |
| `ramcp policy` | Show which paths the AI may access. |
| `ramcp policy allow <path>` | Allow the AI access to a directory. |
| `ramcp policy deny <path>` | Revoke access to a directory. |
| `ramcp policy shell on/off` | Enable/disable shell command execution. |
| `ramcp service install` | Install systemd service + nginx reverse-proxy vhost. |
| `ramcp service uninstall` | Remove service + nginx vhost. |
| `ramcp status` | Check if the service is running. |

## Connecting your chatbot

### ChatGPT (Developer Mode → Connectors)

Use the URL form (ChatGPT can't set custom headers):

```
https://your-domain.com/<token>/mcp
```

Get it ready-made:

```bash
$ ramcp url
https://mcp.example.com/6kX9mQf2.../mcp
```

### Claude / any MCP client with header support

Endpoint: `https://your-domain.com/mcp`
Header: `Authorization: Bearer <token>`

## Tools exposed

**Filesystem** (7) — `list_directory`, `read_file`, `write_file`, `edit_file`, `delete_path`, `search_code`, `file_info`

**Shell** (3) — `run_command`, `process_list`, `kill_process`

**System** (3) — `system_info`, `disk_usage`, `network_interfaces`

**HTTP** (2) — `http_request`, `port_check`

**Git** (1) — `git` (status, diff, log, add, commit, push, pull…)

**SQLite** (2) — `sqlite_query`, `sqlite_schema`

**Policy** (4) — `list_allowed_paths`, `allow_path`, `deny_path`, `shell_enabled`

Filesystem tools are sandboxed by an allow/deny policy (`ramcp policy`). By default nothing is allowed — you decide what the AI can touch. Shell is off by default too.

## Security model

- **Bind-local only.** The gateway listens on `127.0.0.1:8765` — unreachable from the network directly.
- **Token auth on every request.** Two forms supported: bearer header or URL path.
- **Path policy engine.** Filesystem tools resolve symlinks and normalize `..` traversal before checking allow/deny lists. Deny always wins.
- **Shell behind a flag.** Off until you explicitly turn it on.
- **No secrets in logs.** The token is never printed to stdout in full after generation.

You are expected to put TLS in front (nginx + Let's Encrypt, or your CDN edge). The gateway itself speaks plain HTTP on loopback — same pattern as phpMyAdmin, Redis, and every other loopback service.

## FAQ

**Is exposing a shell to an AI safe?**
It's exposing a shell to *you*, via the AI as the interface. The token gates everything; shell is opt-in; filesystem is policy-sandboxed. If you wouldn't give an intern SSH access, don't give them this token.

**Why stateless mode?**
Each request creates a fresh MCP transport. No session state to corrupt, trivially horizontal-scalable, and it's what ChatGPT's connector flow works best with.

**Does it run as root?**
It can, and on a dedicated server that's often simplest — the tools need broad access to be useful. The policy engine is the guardrail, not the UID.

## License

MIT — see [LICENSE](LICENSE).
