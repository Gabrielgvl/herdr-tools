# ADR-018: Preserve bounded model-visible launch failure evidence

## Status

Accepted

## Date

2026-08-30

## Context

Pi's tool-error projection does not preserve custom `Error.details`. A launch can
also mutate a pane, start an agent, or submit a prompt before a later readiness,
transport, or caller-cancellation failure is observed. Reporting only a human
TUI row hides the state a model needs to decide whether retrying is safe. Treating
an aborted or failed mutation as no effect is equally unsafe: a prompt may have
reached an agent even when its acknowledgement was not returned.

Inspection had the same host-boundary problem. A prose success row was not useful
to a model diagnosing a launch failure, while returning raw Herdr records could
expose environment values, unbounded terminal output, or unrelated topology.

## Decision

`herdr_inspect` returns a model-visible JSON text block for health, context/target,
and pane/agent/tab collection results. The projection is compact, environment-safe,
JSON-safe, and bounded to an explicit byte limit. Target results include bounded
identity/metadata and the recent unwrapped terminal tail; collection results cap
items and expose truncation evidence. TUI summaries remain separate from this
model projection.

`herdr_launch` continues to throw typed errors. Each error produced at the launch
boundary includes a bounded, stable `HERDR_LAUNCH_DIAGNOSTIC` JSON record in
`Error.message`, because that is the field Pi exposes to the model. The record
contains the error code, failed phase, known created IDs, agent/prompt/recipient
effect flags, effect certainty, and safe recovery guidance. Rich bounded details
remain attached for Pi/TUI rendering and manual recovery; they are not serialized
to MCP. At the MCP boundary, `herdr_launch` parses only the existing
`HERDR_LAUNCH_DIAGNOSTIC` JSON from `Error.message` and publishes that fixed
payload with the tool name. Raw cause evidence is never model-visible.

Every field of that model-visible text is authored by Tools, and no cause message
reaches it. `CliProtocolError` adopts the Herdr error envelope's `message`
verbatim, and a backend message can quote a command line, an environment value,
or a credential; Tools' own validation messages quote caller-supplied keys and
values, which would let a caller forge a second diagnostic record ahead of the
real one. Control-stripping and a byte bound make neither publishable, and a
per-cause allowlist would have to be right about every message on every path. So
whenever a structured diagnostic is attached the prose is one fixed summary; the
failed phase and recovery guidance are module-owned unions; and a failure code is
published only when it matches the code shape Tools and the CLI transport define.
The cause's own bounded prose is retained as `details.causeMessage`, alongside the
bounded backend envelope under `details.cliFailure`, for Pi/TUI rendering and
manual recovery only. The MCP adapter never serializes those details, including
nested backend messages, stderr/stdout, environment, or recent output. Distinct
recovery advice stays in the diagnostic's `recoveryGuidance`.

A launch error or caller abort triggers reconciliation only after a topology or
other launch mutation has been dispatched (or a genuinely partial launch effect
is already known). Preflight, validation, profile resolution, and other no-effect
failures do not receive extra reads. Reconciliation uses a fresh
`AbortController`, rather than an already-aborted caller signal, and has a short
absolute deadline. Each read runs on a signal derived from that controller, and
the derived signal is aborted the instant the deadline wins, so a read that lost
the race is cancelled rather than left running behind a reconciliation that has
already reported; a read that ignores its signal is still only bounded, never
stopped. The reconciliation deadline is five seconds, preserving bounded
readback while allowing normal MCP/coverage load. It performs read-only snapshot,
pane/agent state, and recent
output reads when possible. The evidence is compacted to fixed fields and bounded
lines. It classifies the observed effect as `absent`, `partial`, or `unknown`;
any failed read prevents an absent conclusion unless authoritative evidence still
proves the target absent. Reconciliation never mutates, retries, sends Enter, or
relaunches.

A prompt acknowledgement followed by unconfirmed consumption is always treated
as an existing-agent effect: the model is told that the prompt may already have
been consumed and must not relaunch or reuse the pane. An agent-not-started or
otherwise attempted mutation directs inspection before retry. Only a failure proven
before any mutation may use no-effect retry guidance.

## Alternatives considered

### Put diagnostics only in `Error.details`

Rejected. Pi drops custom error details at the model boundary, recreating an
opaque launch failure.

### Return a successful structured result for failures

Rejected. Existing tool and host contracts use thrown typed errors for failures;
turning a failed launch into success would make callers and TUI rendering treat an
unsafe partial state as complete.

### Reconcile every failed launch, including preflight failures

Rejected. It adds unnecessary CLI calls, can turn a no-effect refusal into a
misleading topology observation, and violates the pre-mutation validation
boundary.

### Reuse the caller's aborted signal for readback

Rejected. An already-aborted signal suppresses the only observation that can
separate absent, partial, and unknown effects after cancellation.

### Retry after a timeout or uncertain prompt acknowledgement

Rejected. Terminal injection and process startup are not idempotent from Tools'
perspective. A retry could duplicate an assignment or create a second agent.

## Consequences

- Models receive parseable, bounded inspection results and the fixed structured
  launch diagnostic without relying on host-specific detail preservation.
- Pi/TUI retains rich launch details for render-only/manual recovery, while MCP
  uses the fixed diagnostic projection and never exposes raw cause evidence.
- Partial resources and recent failure evidence remain visible for manual recovery.
- Readback adds at most a short read-only reconciliation after a dispatched
  mutation; no-effect failures retain their previous zero-extra-read behavior.
- Unknown evidence remains explicitly unknown, so callers cannot safely infer that
  a relaunch is harmless.
- A future native turn receipt may strengthen prompt-consumption evidence, but
  Tools does not synthesize one or weaken the current fail-closed policy.
