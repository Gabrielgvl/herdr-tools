# ADR-002: Detach long-running Herdr waits into a session job registry

## Status

Superseded by ADR-018: detached-only `herdr_wait` API.

## Context

A blocking `herdr_wait` call is useful for short coordination, but it keeps the
calling tool turn occupied for long waits and cannot reliably survive caller
signal or progress-callback lifetimes. Detached waits must remain authoritative,
observable, cancellable, and bounded without creating hidden Herdr resources or a
second wait implementation.

## Decision

- Use one strict `herdr_wait` schema and a prepared shared runner. The current
  API is detached-only; callers receive an opaque job ID and inspect the job
  through `herdr_jobs`.
- Split waiting into a preflight phase and a prepared shared runner. Preflight
  uses the initiating signal, but registration creates a fresh per-job
  `AbortController`, copies all prepared inputs, and starts the timeout only
  after registration.
- Own one in-memory job registry per extension runtime/session. It uses opaque
  `job_${randomUUID()}` IDs, insertion sequence ordering, no concurrency cap,
  latest-progress replacement, first-wins terminal transitions, and terminal
  retention until shutdown. Operation phase is separate from terminal wait
  result.
- Expose only Herdr-owned jobs through strict `herdr_jobs` list/get/cancel
  operations. Views clone mutable data and truncate model-visible content at the
  existing Pi 50KB/2,000-line bounds.
- Capture a session generation and suppress stale registration, notifications,
  and shutdown races. Shutdown disables delivery first, fences/aborts active
  jobs, then resets ownership. `/tree` and unrelated lifecycle events do not
  cancel jobs.
- Notify the active branch with Pi's normal queue using a visible custom steer
  message after terminal settlement for eligible wait results. Manager
  judgment has the explicit high-priority prefix/details; explicit cancellation
  and shutdown cancellation do not notify. Notification failures are
  best-effort and cannot escape as unhandled rejections.

## Alternatives considered

### One asynchronous wait implementation

Rejected: duplicating polling, timeout precedence, reviewer cadence, or manager
judgment semantics would make foreground and detached waits drift.

### Continue using the initiating signal and `onUpdate`

Rejected: the caller can abort or release those resources after the tool returns;
using them after registration creates cancellation races and stale UI updates.

### Persist jobs or cap concurrent jobs

Rejected: the feature is session-scoped and must not add persistence or an
arbitrary throughput limit. Terminal retention is sufficient for inspection until
session shutdown.

## Consequences

All waits return quickly with an opaque ID while preserving the exact prepared
wait engine. Operators can inspect and cancel jobs without gaining access to
unrelated state. The registry and notification path require explicit lifecycle
and race tests, and notifications are intentionally best-effort because a dying
Pi session cannot reliably deliver them.
