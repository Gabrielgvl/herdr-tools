# ADR-012: Automatically detach long Herdr waits

## Status

Superseded by ADR-018: detached-only `herdr_wait` API.

## Context

A wait longer than the configured review cadence already requires periodic
in-process model supervision. Keeping that wait in the initiating tool turn
holds the caller open even though the wait has an independent watcher and can
finish asynchronously. A detached completion must also wake the initiating Pi
agent so the result is actionable without polling.

## Decision

- If `runInBackground` is omitted and the timeout exceeds the configured review
  cadence, `herdr_wait` automatically registers a session-scoped background job.
- `runInBackground: true` continues to force detachment for any timeout.
- `runInBackground: false` is an explicit synchronous opt-out for callers that
  need the blocking result.
- Both automatic and explicit background waits use the existing shared wait
  runner and mandatory in-process watcher model. The watcher remains tool-less
  and authoritative state/output still decides whether the condition matches.
- Terminal background outcomes use the existing visible Pi steer notification
  with `triggerTurn: true`, waking the initiating agent. Explicit cancel and
  session-shutdown cancellation remain silent.

## Alternatives considered

### Keep long waits synchronous by default

Rejected: it occupies the caller turn despite the wait already having a
periodic watcher and a session job mechanism.

### Add a second polling or watcher implementation

Rejected: automatic detachment must preserve the established timeout,
reviewer, snapshot, and manager-judgment semantics through the shared runner.

### Notify without triggering a turn

Rejected: a visible queued message alone does not reliably resume the agent to
act on the completed wait.

## Consequences

Long waits return an opaque job ID after authoritative preflight, while callers
that explicitly request synchronous execution retain the existing foreground
result and watcher behavior. Existing `herdr_jobs` inspection, cancellation,
active-wait UI, and bounded terminal notifications apply unchanged.
