# ADR-033: Move continuous supervision review to Jev

## Status

Accepted (owner-directed, 2026-09-18)

## Date

2026-09-18

## Context

The supervision reviewer (continuous cadence review of a working child, `src/supervision/reviewer.ts`) deliberately pinned `openai-codex/gpt-5.6-luna` at maximum thinking and declared it not configurable, on the stance that judging a child which has been working with no state transition is a harder judgement than confirming a wait predicate, and therefore needed a frontier model.

Two developments reversed the practical balance:

1. Codex weekly quota exhaustion left supervision blind for entire multi-agent flows (recurring `reviewer_degraded` events); the manager compensated with direct pane reads and per-node gate verification.
2. The wait reviewer already runs the identical classification contract (`progress`, `stalled`, `blocked`, `risk`, `appears_complete`) on Jev via `TypeSafeReviewer` at a fraction of the cost and latency, and the owner ratified active dogfooding as the evaluation stance for Jev-based judgment elsewhere (ADR-032).

The owner directed that continuous supervision also run on Jev.

## Decision

- The supervision reviewer's default model becomes `typesafe/jev-latest`, implemented as a thin adapter that reuses the existing `TypeSafeReviewer` client, question set, parsing, and abort handling. No second question contract is authored.
- Low-confidence answers derive `unknown`, which is already a `SUPERVISION_ATTENTION_CLASSIFICATIONS` member: uncertainty wakes the manager. The threshold stays the wait reviewer's 0.5 — this gate routes to human attention, not to an automated action, so the router's stricter 0.8 does not apply.
- The "harder judgement" model pin and the not-configurable stance are retired. No configuration surface is added: one consumer, one constant. If a second consumer appears, configuration can follow.
- Reviewer failures keep the existing `reviewer_degraded` path: the supervisor retries at the next cadence and the child is unaffected. Supervision availability now depends on Jev authentication/transport instead of Codex quota.
- The Jev API key resolves in order: explicit option, `TYPESAFE_API_KEY` environment variable, then the `typesafe` api_key entry in the Pi auth credential store (`AuthJsonCredentialStore` — the same file the Pi host writes). Key material is never logged or persisted in evidence; resolution failure degrades to the existing typed authentication failure path. This bridge also applies to the wait reviewer's `typesafe/` construction, which today reads the environment only.

## Alternatives considered

### Keep the pinned frontier reviewer

Rejected: supervision went blind under quota pressure exactly when flows need it most; the harder-judgement assumption was never measured, and the owner prefers empirical evaluation through dogfooding.

### Make the supervision reviewer model configurable through `config.json`

Rejected for now: one consumer, no second interpretation; a constant with the Jev default is smaller. Revisit only with a real second consumer.

### Raise the supervision confidence threshold to 0.8 (router parity)

Rejected: the router threshold gates automated fan-out actions; a supervision classification only routes attention to the manager. 0.5 with `unknown` → wake keeps uncertainty pointed at a human, consistent with the wait reviewer.

## Consequences

- The supervision loop no longer depends on Codex quota; cost per cadence review drops by orders of magnitude.
- Whether Jev judges continuous work as well as a frontier model at maximum thinking is now an empirical question. The decision log of record is the existing supervision review evidence; if dogfooding shows misjudgement, revisit with data rather than by reverting silently.
- Implementation is a follow-up change (adapter + constant + unit tests reusing the injected-fetch fixtures) and deliberately stays out of the ADR-032 deliverable set to keep its reviewed manifest clean.
