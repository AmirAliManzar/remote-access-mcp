# Changelog

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
