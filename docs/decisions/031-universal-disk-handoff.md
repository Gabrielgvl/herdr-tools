# ADR-031: Tools-owned disk handoff as the managed completion gate

## Status

Accepted for Pi, Claude, and Devin. AGY remains unqualified.

## Date

2026-09-15

## Context

Pane status and cooperative `kind: "result"` messages are not durable completion records. Herdr core owns raw lifecycle state, but Herdr Tools owns managed launch, supervision, waits, and job projections. Tools can therefore refuse to accept or advance a managed terminal observation without pretending to veto the core transition.

## Decision

Each qualified launch receives a generated run UUID and a handoff path under the endpoint-private Herdr Tools state namespace. Callers cannot supply the path. The Markdown file contains exactly `Status`, `Summary`, `Changes`, `Verification`, `Blockers`, and `Continuation`, plus a generated run marker. Status is `done`, `blocked`, `cancelled`, or `failed`; `Changes` is a path list or `None`. Missing, empty, duplicate, extra, placeholder, foreign-run, stale-cycle, or oversized content is invalid.

For an authoritatively identified managed run, handoff evidence is independent from raw `agent_status`. A `completed` wait treats both `idle` and `done` as unmatched until the current artifact validates. A `terminal` wait likewise remains unmatched for every terminal outcome until a current artifact with the corresponding status validates. Validation happens in asynchronous per-target reads before `any` or `all` aggregation. Identityless non-strict waits remain observation-only and explicitly ungated.

A missing or invalid artifact leaves the run awaiting handoff. Tools may prompt the exact child to repair the same path, with the repair attempt persisted before sending. Turn-level Escape, cancel, or interrupt does not cancel a run. A Tools-authored `cancelled` fallback requires confirmed run-level cancellation or authoritative exit. Async settlement persists required fallback evidence first; pre-bind release is launcher cleanup; shutdown fabricates nothing and leaves unresolved state `recovery_pending`.

The versioned sidecar reserves the exact endpoint, manager, child and native-session identity, lifecycle watermark, artifact digest, and repair fence needed for future restoration. Automatic restart recovery is deferred. A new host may re-prompt once for the same artifact version until restoration ships.

Paths are derived from generated UUIDs beneath a trusted endpoint namespace. Validation rejects traversal, symlink components or leaves, non-regular files, wrong ownership, unsafe modes, multi-link leaves, replacement races, and oversized input. Tools uses bounded no-follow reads with descriptor checks and atomic same-directory writes. State follows endpoint lifetime. Same-UID agents are cooperative rather than hostile isolation, and no fallback is guaranteed if every monitor dies before persistence.

## Rejected alternatives

- A Herdr core completion veto. The accepted contract gates Tools-managed acceptance instead.
- A general database, daemon, watcher, or sweeper.
- Transcript scraping or pane text as the completion record.
- Caller-selected paths or per-profile static instructions.
- Treating every turn cancel or interrupt as run cancellation.
- Restoring manager authority across restart in this delivery.

## Consequences

- Pi, Claude, and Devin share one managed completion rule and one durable evidence shape.
- Raw Herdr status may say `idle` or `done` while Tools correctly reports awaiting handoff.
- `herdr_inspect`, `herdr_wait`, supervision, and job details expose bounded artifact evidence.
- `kind: "result"` remains communication, not acceptance.
- Restarted hosts expose unresolved work as `recovery_pending` until restoration is implemented.
- AGY remains fail-closed under `AGY_UNQUALIFIED`.
