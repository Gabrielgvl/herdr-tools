# ADR-034: Supervision reviewer contract V2 — probabilistic signals, evidence gate, assignment digest

## Status

Accepted (owner-directed, 2026-09-18). Implementation travels with ADR-033 in the same deliverable set and branch (`supervision-jev-reviewer`): node 1 = ADR-033 adapter and auth bridge (in flight), node 2 = this contract. The digest's launch-schema seam touches `launch.ts`, which the `jev-router-batch` branch also modifies; the small conflict is reconciled at integration, not by deferring this decision.

## Date

2026-09-18

## Context

ADR-033 moved the supervision reviewer to Jev by reusing the wait reviewer's single `choice` question verbatim. Owner review found the inherited contract weak in four ways:

1. The five labels are not mutually exclusive states; a child can be progressing and risky at once, and a single choice collapses independent judgments.
2. `risk` and `appears_complete` promise semantics the reviewer cannot honor without knowing the assignment — "advancing toward a wrong outcome" and "looks finished" are unjudgeable from transcript evidence alone.
3. `unknown` derived from max-probability < 0.5 measures ambiguity between labels, not sufficiency of evidence; an empty delta during a long build can yield a confident distribution.
4. Free-text summaries are unusable for tuning; there is no memory across reviews, so `stalled` — an inherently temporal property — is judged from each 5-minute window in isolation.

## Decision

- **Six independent `noul` predicates in one `systemOne` call**: `evidence_sufficient`, `making_progress`, `stalled`, `blocked`, `risk`, `appears_complete`. Non-exclusive by design; no predicate requires the others to be low. `progress .88 + risk .72` classifies `risk` — advancing quickly in the wrong direction is risk, not contradiction.
- **Evidence gate**: `P(evidence_sufficient) < 0.60` → `unknown` before any signal evaluation. Conceptually separate from signal activation: one gate answers "can we judge?", the other "what do we see?".
- **Per-signal activation thresholds** (owner-ratified starting points; the cost of error differs per signal):

```text
evidence_sufficient  >= 0.60   (gate)
risk                 >= 0.60   (wakes a human; favor recall)
blocked              >= 0.65
appears_complete     >= 0.70   (coding agents habitually claim done early)
stalled              >= 0.70   (5 minutes is a short window; builds/tests/idle subprocesses look like stalls)
progress             >= 0.60
```

- **Deterministic precedence reducer**: `risk` → `blocked` → `appears_complete` → `stalled` → `progress` → `unknown`. Co-activating signals (e.g. `progress .74 + blocked .81`: progressed, then blocked) are recorded as reason codes, never as the classification. No signal crossing → `unknown` (fallthrough; the reducer never forces a label from a low-resolution zone).
- **Authorial supervision digest in the launch contract**: a new optional caller-authored field carrying `doneWhen` conditions and `constraints` (e.g. "read-only", "no repository mutations"), recorded at reservation — bounded in bytes, redacted by the existing allowlist, and supplied to the reviewer as part of the state. This gives `risk` (out-of-scope direction) and `appears_complete` (done-when met without terminal state) real semantics. Owner explicitly chose the authorial surface over deriving from `objective`/`verification`.
- **Temporal memory, in-memory only**: the supervisor keeps `previousReview` (classification, signals, `lastMeaningfulProgressAtMs`) per child for the life of the reservation; restart resets it, which is acceptable for a 5-minute cadence. Runtime signals (`linesSinceLastReview`, output recency) inform reasons, never classify alone — silence during a build is `no_output`, a reason code, not `stalled`.
- **Reason codes**: one additional `choice` question in the same call over a fixed set (repetition, no_output, oscillation, external_dependency, missing_permission, tool_failure, scope_drift, destructive_action, incorrect_direction, completion_claim, artifact_produced, verification_passed, none). Persisted in the existing per-review records for aggregate tuning ("why do children block: 42% missing_permission…"). Not part of the public contract.
- **All probabilities are logged**, including non-activating ones.
- **`stalled` definition**: "evidence of repeated attempts, oscillation, idling, or lack of semantic advancement over sufficient elapsed time" — never mere absence of output.
- **Public contract unchanged**: `SupervisionReviewRequest` → `{classification, summary}`. The V2 evidence and judgment shapes are internal to the reviewer module; the deterministic reducer keeps every existing consumer working.
- **Hysteresis (enter/remain thresholds, e.g. `stalled` 0.70/0.60) is deliberately deferred to V2.1** until real per-signal distributions exist. First patch ships the fixed thresholds above and logs everything needed to tune them: distribution around each threshold, classification transitions, human override rate, false-positive wakeups, time-to-detect real stalls and blocks. Thresholds are not revisited before that data exists.

## Relationship to ADR-033

ADR-033's client, parsing, abort handling, and adapter pattern survive unchanged. Its "reuses the existing question set unchanged" line is superseded by this contract; the 0.5 max-probability `unknown` derivation is replaced by the evidence gate plus reducer fallthrough.

## Alternatives considered

### Deriving the digest from `objective`/`verification` instead of a new authorial field

Rejected by the owner: done-when and constraints are semantically distinct from verification prose, and forcing callers to overload existing fields loses the explicit contract. Cost accepted: new schema surface on the launch input.

### Single choice with weakened `risk`/`appears_complete` wording

Rejected: keeps the collapse of independent judgments and discards the co-occurrence information (progressing-but-risky) that makes supervision useful.

### Persisting temporal state across supervisor restarts

Rejected: new serialization/cleanup machinery for a signal on a 5-minute cadence; in-memory is sufficient for flap detection within a reservation's life.
