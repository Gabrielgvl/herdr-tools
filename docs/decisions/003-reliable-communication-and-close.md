# ADR-003: State-aware communication and reconciled autonomous close

## Status
Accepted for close reliability; communication/steer decision superseded by ADR-004

> **Supersession:** The steer/interrupt decision and consequences below are historical and must not be implemented. ADR-004 is authoritative for communication. The close-reliability decision remains active.

## Date
2026-08-07

## Context

The Herdr Tools adapter runs against the installed Herdr 0.8 CLI. Two reliability failures were observed:

- `steer` always sent Escape, including to idle agents, which could abort an idle turn before the requested prompt was delivered.
- Explicit close calls could block on an interactive ownership confirmation and, when the initiating turn was aborted after Herdr completed the destructive command, lose the terminal result.

The adapter must not change Herdr core or HCP, add dependencies, or claim atomicity that the current CLI does not provide. The existing extension must continue to expose exactly seven tools and must not leak environment data.

## Decision

1. `herdr_communicate` reads authoritative pane state before sending bytes. `prompt` refuses `working`; `steer` sends the prompt directly for `idle`, `done`, or `blocked`, and sends canonical named `esc`, waits boundedly for `idle`/`done`/`blocked`, then prompts only after Herdr returns matching `agent_info` for the exact pane in a settled state. Unknown or malformed state and malformed/mismatched settle acknowledgement are typed no-send failures.
2. Communication details retain bounded envelope IDs for interrupt/wait/prompt/post-state operations, pre/post state, and the route (`prompt_direct` or `interrupt_then_prompt`).
3. `herdr_pane`, `herdr_tab`, and `herdr_communicate` are registered with `executionMode: "sequential"`. Read-only inspect, wait, and jobs tools remain unchanged.
4. Exact explicit pane/tab close is autonomous after fresh topology and protected-caller validation. Ownership and modal confirmation are removed from close policy. The caller pane, containing tab, and containing workspace remain protected. Malformed topology fails closed.
5. Close runs with completed-mutation preservation and captures the Herdr envelope ID/result. It performs a fresh independent post-topology read after dispatch. If a dispatched response is lost or protocol-invalid, one independent readback may reconcile a truthful terminal result only when the target is absent; otherwise it throws typed `MUTATION_UNCERTAIN` with bounded evidence and never retries. CLI/backend unavailability that proves dispatch never began propagates directly and never reconciles.
6. Close results return only operation ID, target ID, removed IDs, and a compact sanitized post-topology summary. Full snapshots and environment data are not returned.

## Alternatives considered

### Always interrupt before steer

Rejected. It is the direct cause of the idle-agent failure and adds destructive key input when no interruption is needed.

### Keep ownership confirmation for unowned targets

Rejected. Explicit exact close is the product authorization. Modal UI made non-interactive calls hang and did not add useful authorization for a caller-requested exact target. Caller resources are protected independently.

### Retry a close when the response is lost

Rejected. A retry could close a different resource after topology changed or repeat an already completed destructive command. Reconcile once from an independent readback instead.

### Treat adapter preflight as atomic compare-and-close

Rejected. Herdr 0.8 has no conditional close/prompt flags. The adapter validates fresh state and verifies post-state, but cannot eliminate the race. Upstream Herdr must eventually provide compare-and-send/compare-and-close semantics.

## Consequences

- Idle/done/blocked steer no longer emits Escape, and working steer has a bounded interrupt-settle-prompt sequence.
- Concurrent mutating tool calls are serialized by Pi; read-only tools retain existing concurrency behavior.
- Explicit close works without UI access for non-caller targets and has truthful uncertainty behavior after lost responses.
- The runtime ownership ledger remains for resource tracking and launch bookkeeping, but is not a close authorization gate.
- The remaining preflight-to-mutation race is documented and visible as an upstream limitation, not masked by a compatibility layer.
