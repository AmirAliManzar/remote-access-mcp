# Contributing

Thanks for contributing to Remote Access MCP.

## Before opening a pull request

```bash
npm ci
npm run lint
npm run build
npm test
```

Changes that affect authentication, filesystem policy, shell execution, SSRF protection, audit logging, transport handling, or Codebase Memory isolation should include regression tests.

## Development rules

- TypeScript is strict and ESM-only.
- Keep changes focused and small.
- Do not weaken security checks to make a test or integration pass.
- Tests must not depend on a developer's real Remote Access MCP configuration.
- Never commit tokens, credentials, generated configuration backups, or runtime state.
- Update documentation when a public CLI command, environment variable, security boundary, or supported runtime changes.

## Commit messages

Use concise conventional commit-style messages, for example:

- `fix: isolate codebase memory runtime`
- `docs: update node compatibility`
- `test: cover token policy regression`

## Pull requests

Describe what changed, why it changed, how it was tested, and any security or compatibility implications.
