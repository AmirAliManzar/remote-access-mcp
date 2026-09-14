# Remote Access MCP

<p align="center">
  <strong>Give your AI assistant real access to your computer.</strong><br>
  Turn ChatGPT, Claude, Grok, Qwen Desktop, and other MCP clients into an agent that can work on your laptop, desktop, VM, or server.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/remote-access-mcp"><img src="https://img.shields.io/npm/v/remote-access-mcp.svg" alt="npm"></a>
  <a href="https://github.com/AmirAliManzar/remote-access-mcp/actions/workflows/ci.yml"><img src="https://github.com/AmirAliManzar/remote-access-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/AmirAliManzar/remote-access-mcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow.svg" alt="MIT"></a>
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933.svg" alt="Node.js 18+">
</p>

> **The idea:** Your chatbot already knows how to reason. Remote Access MCP gives that reasoning a controlled pair of hands on a machine you own.

## What is Remote Access MCP?

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) lets AI applications use external tools and data. **Remote Access MCP is the bridge between an MCP-compatible AI client and a real machine.**

Install it on a laptop, desktop, VM, home server, cloud server, or development box. Connect your AI client, grant it only the directories and capabilities it needs, and let the agent actually do the work.

Instead of:

> "Here is the error. Tell me what command I should run."

You can have an agentic workflow:

> "Inspect the project, reproduce the bug, edit the files, run the tests, check the logs, fix the issue, and tell me exactly what changed."

The AI can perform the loop instead of merely describing it.

### From chatbot to agent

```text
┌──────────────────────┐
│  ChatGPT / Claude    │
│  Grok / Qwen / etc.  │
└──────────┬───────────┘
           │ MCP / HTTPS
           ▼
┌──────────────────────────────┐
│      Remote Access MCP       │
│ auth · policy · audit · jobs  │
└──────────────┬───────────────┘
               │ controlled tools
       ┌───────┼────────┬──────────┐
       ▼       ▼        ▼          ▼
    Files    Shell    Git      Browser
       │       │        │          │
       └───────┴────────┴──────────┘
                    ▼
             Your real machine
```

## What can the agent actually do?

Depending on the permissions you grant, an MCP client can:

- inspect and understand a codebase
- create, edit, move, and delete files
- upload and download binary files
- run tests, linters, builds, scripts, and development commands
- inspect processes, disks, network interfaces, logs, and services
- work with Git repositories
- query SQLite, MySQL, PostgreSQL, and Redis through controlled adapters
- inspect HTTP endpoints and browser pages
- create background jobs and run bounded tasks in parallel
- schedule recurring work and react to webhooks, file, and health events
- diagnose infrastructure and common Docker/Kubernetes environments
- create snapshots and roll back risky filesystem changes
- use optional Context7, Codebase Memory, and other MCP integrations

That means the AI can follow a real **observe → plan → change → test → verify** loop.

## Why this is different

Most AI chat experiences stop at generated text. Coding agents improve that by giving the model a workspace. Remote Access MCP takes the same idea to **the machine itself** while keeping the operator in control.

It is designed for:

- 💻 **Laptops & desktops** — let your AI work on your local development environment.
- 🖥️ **Servers** — inspect services, logs, deployments, files, and infrastructure remotely.
- 🧪 **Development & CI environments** — build, test, diagnose, and verify instead of guessing.
- 🏠 **Home labs & self-hosted systems** — connect an AI client without building a custom agent platform.
- ☁️ **Cloud VMs** — expose a controlled MCP endpoint without handing over an unrestricted SSH account.

### Cross-platform

The core gateway is designed for **Linux, macOS, and Windows** with Node.js 18+.

- Linux → systemd when you want a persistent service
- macOS → launchd when you want a persistent service
- Windows → Scheduled Tasks when you want a persistent service
- Any platform → foreground mode or supported tunnel/direct connection

## Quick start

### 1. Install

```bash
npm install -g remote-access-mcp
```

Or on Ubuntu/Debian:

```bash
curl -fsSL https://raw.githubusercontent.com/AmirAliManzar/remote-access-mcp/main/install.sh | bash
```

### 2. Initialize

```bash
ramcp init
```

`ramcp` is the CLI and interactive TUI (terminal user interface). Run it with no arguments in an interactive terminal to open the guided interface.

### 3. Decide what the AI may access

Start narrow. For example:

```bash
ramcp policy allow ~/Projects/my-app
ramcp policy shell on
```

You can create separate tokens for separate agents or use cases:

```bash
ramcp token add --name developer \
  --paths ~/Projects/my-app \
  --scopes filesystem,git,shell \
  --shell
```

### 4. Connect your AI client

For a client that accepts a token in the URL:

```text
https://your-host/<token>/mcp
```

For clients that support an Authorization header:

```text
https://your-host/mcp
Authorization: Bearer <token>
```

Use:

```bash
ramcp url
```

to print the connector URL for the current runtime.

## Laptop / desktop: no domain required

You do not need to buy a domain or configure port forwarding just to experiment.

```bash
ramcp tunnel
```

Remote Access MCP can use a supported tunnel provider and print a public HTTPS endpoint. Auto mode remembers the last successful provider and prefers it on the next run.

You can also use direct HTTP when appropriate:

```bash
ramcp tunnel --direct
```

Direct mode chooses a high dynamic port rather than common service ports and performs availability/health checks before presenting the endpoint.

> Free tunnel providers may assign a new hostname after a tunnel is recreated. A provider's free tier controls hostname persistence, not Remote Access MCP.

## Server deployment

For a Linux server with a domain:

```bash
ramcp init
ramcp policy allow /srv/myapp
ramcp policy shell on
ramcp service install --domain mcp.example.com
ramcp doctor
ramcp url
```

The service setup is intended to keep the gateway local and put your chosen HTTPS edge/reverse proxy in front of it.

## Agentic workflows

Remote Access MCP is not just a collection of shell wrappers. The toolset is designed so an AI agent can complete multi-step work.

### Example: fix a failing project

```text
User:
  "The tests are failing. Find the cause, fix it, run the relevant tests,
   and verify that the fix didn't break anything else."

Agent:
  1. Inspect project structure
  2. Read relevant files
  3. Run the failing test
  4. Inspect output/logs
  5. Edit the code
  6. Run focused tests
  7. Run broader verification
  8. Report files changed + results
```

### Example: investigate a server

```text
"Why is this server slow? Check CPU, RAM, disk, processes, network,
logs and services. Identify the bottleneck and propose or perform the
lowest-risk fix, then verify the result."
```

### Example: build something

```text
"Create the project in /srv/demo, install its dependencies, implement
the feature, run the tests and leave me a working build."
```

The important difference is that the model gets **tools + state + feedback**, so it can iterate against the real environment.

## Safety model

Remote Access MCP is deliberately permission-oriented. Installing it does **not** mean giving an AI unrestricted root access.

### Per-token permissions

Tokens can have:

- allowed paths
- explicit denied paths
- tool scopes
- roles: `auditor`, `developer`, `deployer`, `admin`
- shell permission
- command allowlists
- read-only mode
- request-rate limits
- expiration

Example read-only token:

```bash
ramcp token add \
  --name auditor \
  --paths /srv/myapp \
  --scopes filesystem,git \
  --read-only
```

### Defense in depth

The project includes protections such as:

- path resolution that handles `..` and symlinks before policy checks
- deny rules that win over allow rules
- timing-safe token verification
- secret redaction in operational output
- SSRF protections for private/loopback/cloud metadata ranges
- Git command/argument validation
- SQLite single-statement restrictions and blocked `ATTACH`
- protected service/process controls
- bounded command output and timeouts
- persistent audit logging with hash-chain verification
- filesystem snapshots and rollback support
- optional plugin isolation with fail-closed behavior
- autonomous recovery disabled by default

**Security is not a promise that an AI can never make a mistake. The goal is to make its capabilities explicit, bounded, observable, and revocable.**

See [SECURITY.md](SECURITY.md) for the security model and reporting guidance.

## Background jobs & parallel work

Long-running work does not have to block the request that started it.

The gateway provides bounded worker execution for:

- background commands
- parallel operations
- retries with limits
- cancellation
- timeouts
- captured output
- persistent job metadata
- per-token ownership

This is useful when an agent needs to build/test several components, wait for a long-running task, or perform independent checks concurrently.

## Automation & events

Automation rules can be triggered by intervals and supported tool, webhook, file, and health events. Actions still pass through the normal token policy, scopes, read-only controls, and audit layer.

This lets you build workflows such as:

```text
webhook → inspect deployment → run health checks → collect logs → notify
```

or:

```text
health event → bounded recovery action → verify → record incident
```

Autonomous recovery is disabled by default and requires explicit operator configuration.

## Plugins & integrations

Optional integrations can extend the gateway without making them mandatory for the core runtime.

Supported/available integrations include:

- **Context7** for library/documentation context
- **Codebase Memory** for repository-aware code context
- **Context Mode** as an optional local integration
- local plugins with validation, fingerprints, namespaced tools, and isolation controls

Each Remote Access MCP instance can keep its Codebase Memory runtime/data/cache identity isolated from other applications on the same machine.

## CLI & TUI

The command line remains script-friendly while the interactive terminal UI provides a guided operator experience.

```bash
ramcp                 # interactive TUI in a real terminal
ramcp doctor          # diagnose the environment
ramcp status          # runtime/service summary
ramcp service status  # service state
ramcp service logs -f # follow logs
ramcp tunnel          # public connection
ramcp url             # current connector URL
ramcp token list      # token fingerprints
ramcp audit --verify  # verify audit hash chain
```

The TUI is an operator interface, not a general server-control center. It focuses on configuring, starting, connecting, securing, diagnosing, and operating Remote Access MCP itself.

## Core capabilities

Remote Access MCP includes a broad operational toolkit covering:

| Area | Examples |
|---|---|
| Filesystem | list, read, write, edit, delete, search, upload/download |
| Shell | controlled commands, process listing, process termination |
| System | system info, disk usage, network interfaces |
| HTTP | requests, port checks, web fetching with SSRF guards |
| Git | validated repository operations |
| Databases | SQLite, MySQL, PostgreSQL, Redis |
| Logs | files and journal/service logs |
| Services | status and controlled actions |
| Packages | inspect/install/remove with protected system packages |
| Planning | task plans, snapshots, rollback |
| Scheduling | persistent bounded scheduled tasks |
| Automation | event-driven rules and webhooks |
| Browser | optional browser open/extract/screenshot capabilities |
| Infrastructure | Docker/Kubernetes/Cloudflare diagnostics where the local CLI is available |
| Security | secret scanning, local port scanning, audit verification |

The exact built-in tool surface can evolve between releases; use the installed version's `doctor`, documentation, and MCP tool list as the source of truth.

## Requirements

- Node.js **18+** for the core gateway
- Linux, macOS, or Windows
- An MCP-compatible client for agent interaction
- Optional system utilities depending on the capabilities you want to use

No Python runtime and no Docker runtime are required for the core gateway.

## Open source

Remote Access MCP is MIT licensed and intended to be useful as infrastructure for developers, self-hosters, AI-agent builders, and automation projects.

```bash
git clone https://github.com/AmirAliManzar/remote-access-mcp.git
cd remote-access-mcp
npm install
npm test
npm run build
```

Contributions, bug reports, security reports, ideas, and real-world agent workflows are welcome.

## Documentation

- [Persian README](README.fa.md)
- [Roadmap](ROADMAP.md)
- [Security](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT © Amir Ali Manzar
