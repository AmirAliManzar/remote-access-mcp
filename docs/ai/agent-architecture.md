# Agent Architecture Contract

This document defines the stable foundation for the post-3.1 agent layers.
It is deliberately a contract, not an implementation promise: Phase 1 adds
context processing, Phase 2 adds capability routing, and Phase 3 adds task
orchestration on top of these shapes.

## Design goals

1. Reduce model context and round trips without hiding important facts.
2. Keep low-level tools available while exposing higher-level capabilities.
3. Make mutation explicit, policy-checked, verifiable, and recoverable.
4. Make long-running work resumable rather than dependent on one request.
5. Keep existing MCP transport, per-request policy isolation, and Node 18
   support intact.

## Layers

```text
MCP request
    |
    v
Task / Intent
    |
    v
Capability Router -----> Policy
    |
    v
Execution
    |
    v
Verification / Recovery
    |
    v
Context Engine -----> compact AgentResult
```

The Context Engine is cross-cutting: it may reduce tool results and select
relevant prior state, but it must never silently change a mutation's meaning.

## AgentResult

New agent-facing workflows should converge on:

```json
{
  "ok": true,
  "summary": "short human/AI-readable result",
  "data": {},
  "warnings": [],
  "errors": [],
  "nextActions": []
}
```

`sizeBytes` and `resultId` are optional metadata for context accounting and
large/persisted results. Existing tools are not being rewritten wholesale in
Phase 0; adapters belong to the Context Engine phase.

## CapabilityDescriptor

Every future routed capability should declare:

- stable `id` and category
- risk and execution mode
- required scopes
- approximate context cost
- dependency capabilities
- dry-run support
- verification support

`contextCost` is an estimate used for routing/budgeting, not a billing meter.

## ContextBudget

The future engine partitions a total budget into history, tool results,
memory, and a reserved safety margin. Allocations must never exceed total.
This is a planning contract; the current MCP server does not impose an
artificial token limit on clients.

## Task lifecycle

```text
queued
  -> planning
  -> awaiting_approval (when required)
  -> executing
  -> verifying
  -> completed
```

Failure/recovery paths are explicit:

```text
planning -> failed
executing -> failed / rolled_back / cancelled
verifying -> executing / failed / rolled_back
failed -> planning / executing / rolled_back / cancelled
rolled_back -> planning / cancelled
```

A completed or cancelled task is terminal.

## Compatibility rules

- Do not replace the existing `ToolContext` in-place until an adapter has
  been tested across the full transport/auth suite.
- Do not cache `McpServer` instances across requests: policy hot-reload and
  token revocation depend on fresh registration.
- Codebase Memory remains project-isolated under its dedicated RAMCP runtime;
  no future agent layer may reuse another service's Codebase Memory state.
- Node >=18 remains supported unless a future major release explicitly
  changes the support policy.
- No automatic push/publish is part of an implementation phase.

## Phase boundaries

- **Phase 0:** contracts, architecture, baseline measurements.
- **Phase 1:** Context Engine and measured token/output reduction.
- **Phase 2:** Capability Registry/Router and batched/parallel operations.
- **Phase 3:** Task/Workflow Engine, approvals, verification, recovery.

Later phases add integrations and autonomous operations without weakening
these invariants.

## Phase 0 baseline (2026-09-06)

The reproducible benchmark is `scripts/benchmark-agent-baseline.mjs`. It runs
30 post-warmup registrations of the current tool set with integrations disabled
and measures only registration overhead; it does not mutate the host.

Observed baseline on the development server:

| Metric | Baseline |
|---|---:|
| Registered tools | 69 |
| Samples | 30 |
| Registration p50 | 1.77 ms |
| Registration p95 | 12.21 ms |
| Registration average | 3.10 ms |
| Process RSS after benchmark | 108.1 MB |

These are engineering baselines, not universal performance guarantees. Future
phases must report the same measurements after changing the registration,
context, or routing path and must preserve correctness benchmarks separately.
