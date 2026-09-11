# Changelog

## 4.3.0 - TUI Experience

- Added an interactive terminal UI when `ramcp` is launched without arguments from an interactive terminal.
- Added a guided first-run setup wizard for filesystem access and connection/tunnel selection.
- Added a MARS-focused dashboard for MCP runtime, connection, tunnel, authentication and audit status.
- Added interactive tunnel/provider selection for Auto, Pinggy, Cloudflare, localhost.run and Direct HTTP.
- Added TUI views for tokens/access, diagnostics and operational output while preserving the existing script-friendly CLI commands.
- Kept TUI scope limited to Remote Access MCP; it does not act as a general server control center.
- Added the Blessed terminal UI runtime dependency and packaging support.

## 4.2.0 - Persistent Public Access

- Added direct HTTP fallback on high dynamic ports only.
- Reserved common public/service ports such as 80, 443, 8443, 2083, 2087 and 2096.
- Added automatic UFW allow/cleanup for direct HTTP ports when available.
- Added public IPv4 detection and direct connector URL output.
- Added preferred tunnel provider persistence so auto mode retries the last successful provider first.
- Persisted the last tunnel URL as historical state without presenting stale URLs as live.
- `ramcp url` now reports the live direct HTTP connector when active.


## 4.1.0 - Multi-Provider Tunnels

- Added pluggable tunnel providers: Cloudflare Quick Tunnel, Pinggy, and localhost.run.
- Added `--provider cloudflare|pinggy|localhostrun|auto` selection and automatic fallback.
- Cloudflare Quick Tunnel URL parsing now explicitly rejects `api.trycloudflare.com`, preventing the control-plane API endpoint from being shown as the public MCP URL.
- Provider selection remains opt-in; existing production `mcp.amiralimanzar.ir` configuration is not changed by tunnel provider support.


## 4.0.0 - Final Hardening

### Security & Reliability
- Hardened plugin registry mutations with a cross-process lock and atomic lockfile replacement.
- Plugin installation now cleans up partial destinations on failure and revalidates the copied manifest before fingerprinting.
- Final release verification covers build, type checking, the complete regression suite, dependency audit, diff hygiene, production boot, Codebase Memory isolation, plugin sandbox behavior, tamper detection, and concurrent plugin installation.
- No automatic publishing or registry distribution is performed by the release process.

## 3.9.0 - Plugin Isolation & Ecosystem

### Added
- Out-of-process MCP plugin hosting with short-lived child processes.
- Plugin manifest validation, SHA-256 installation fingerprints and fail-closed integrity verification.
- Namespaced plugin tools (`plugin_<name>__<tool>`) with token-scope and read-only gates.
- Node filesystem permission isolation, dedicated plugin `data/` write area, optional child-process permission, Linux network namespace isolation and deny-by-default network controls.
- Bounded plugin startup/execution time and explicit `RAMCP_PLUGIN_UNSANDBOXED=1` escape hatch for operators who intentionally accept local-trust execution.

### Changed
- The old `trusted: true` in-process plugin model is no longer a security boundary and is not accepted by the installer.
- There is no automatic remote plugin registry/download path; plugin installation remains local and explicit.

## 3.1.2 - Critical Packaging Fix

### Fixed
- **`ramcp` / `remote-access-mcp` commands were broken in published 3.1.0 and 3.1.1**: the `bin` entries pointed at `dist/cli.js`, which stopped being generated when the duplicate `src/cli.ts` entry was removed. Bin entries now point at the real entry `dist/main.js`.
- CI's smoke test had been failing on this since 3.0.2 — the release workflow (which lacks the smoke step) kept publishing broken tarballs.

## 3.1.1 - Security & Reliability Hardening

### Fixed
- Hardened command allowlists against shell chaining, redirection, substitution and other operator-based bypasses.
- Removed production dependency audit findings by pinning the vulnerable `qs` transitive dependency through an npm override.
- Hardened managed filesystem change sets with pre-mutation capture, create/delete tracking and resumable rollback.
- Made background job persistence safe across concurrent gateway processes with locking, merged writes and live-owner protection.
- Made shell approvals durable across restarts and bound them to the exact command and working directory.
- Approvals are now atomically single-use and record the approving token fingerprint.
- Required explicit `trusted: true` for local plugins and prevented plugin entrypoints from escaping their plugin directory.
- Implemented the `ramcp://audit` resource instead of returning a placeholder.

### Security notes
- Plugins remain an explicitly trusted in-process extension mechanism; they are not a sandbox.
- Health watchers persist their configuration and recover after gateway restart; a single live gateway process owns each watcher, and they remain application-level timers rather than OS services.


## 3.1.0 - Parallel Workers & Agent Operations

### Added
- Bounded background job worker pool with persistent job metadata, output capture, cancellation, timeouts and retries.
- `run_parallel` for bounded parallel shell task execution.
- Binary-safe `upload_file` / `download_file` with size limits and SHA-256 verification.
- Command allowlists, approval mode and approval decisions for shell operations.
- Transaction-style change sets with backup, commit and rollback.
- MySQL/PostgreSQL/Redis CLI-based database query support with environment-held credentials.
- Structured system and service diagnostics.
- Health watchers with webhook alerts.
- MCP Resources for system, services, network, projects and audit context.
- MCP Prompts for diagnosis, deployment, security audit and project inspection.
- Token roles: auditor, developer, deployer and admin.
- Local trusted plugin manifest/install/remove/list management.

### Compatibility
- Node.js 18+ remains supported.


All notable changes to Remote Access MCP are documented here.

## [3.0.2] - 2026-09-01

- Standardized the core runtime requirement at Node.js 18+.
- Moved optional MCP integrations out of the mandatory dependency set so the core gateway can install on supported Node.js 18 environments.
- Hardened the dedicated Codebase Memory runtime isolation used by Remote Access MCP.
- Kept Codebase Memory state separate from other services on the same machine.
- Added regression coverage for per-instance runtime, cache, data, and workspace paths.

## [3.0.1]

- Initial 3.0.x patch release before the documentation, packaging, and isolation hardening in 3.0.2.

## [3.0.0] - 2026-09-01

- Removed fleet / multi-server orchestration to keep the gateway focused on one machine per instance.
- Retained webhooks and configuration backup/restore as local gateway capabilities.
- Improved transport compatibility and security boundaries around local operations.

## [2.x]

See the repository history for changes from the 2.x development line.
