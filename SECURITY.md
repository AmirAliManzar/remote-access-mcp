# Security Policy

Remote Access MCP can execute commands, modify files, manage services, and inspect a machine on behalf of an AI agent. Security issues are therefore treated as high priority.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for an undisclosed security vulnerability.

Report security issues privately to the repository owner through GitHub's private vulnerability reporting feature when available. Include:

- affected version or commit;
- operating system and Node.js version;
- clear reproduction steps or a minimal proof of concept;
- impact and required permissions/token scopes;
- any suggested mitigation.

Do not include real passwords, API keys, private keys, production tokens, or other secrets in a report.

## Scope

Security reports are especially valuable for:

- authentication or token bypasses;
- filesystem sandbox escapes, including symlink/path traversal issues;
- shell or command injection;
- SSRF bypasses;
- privilege escalation;
- audit-log tampering or credential leakage;
- cross-instance Codebase Memory isolation failures;
- unsafe transport or webhook behavior;
- release or package supply-chain issues.

## Supported versions

The `main` branch and the latest published release are the primary supported versions. Older releases may not receive security fixes.

## Security model

See [`docs/ai/security-model.md`](docs/ai/security-model.md) for the detailed threat model, authentication, policy enforcement, SSRF protections, audit chain, and protected operations.

For production deployments, use a TLS-terminating reverse proxy, least-privilege tokens, read-only mode where possible, and rotate tokens immediately if a credential backup or token is exposed.
