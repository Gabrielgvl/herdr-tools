# ADR-032: Active Jev routing with auto-only batch launch

## Status

Accepted

## Date

2026-09-17

## Context

The profile catalog holds 24 profiles across 7 roles and up to 4 runners, and every launch already passes through `herdr_launch` (ADR-008). The launching manager — a frontier model — currently chooses role, profile, and fan-out by hand on every delegation. TypeSafe's Jev (decision-only model: typed questions in, calibrated probabilities out, no generated text) is already integrated as the opt-in wait reviewer (`typesafe/` prefix, ADR-quality precedent in `src/typesafe-reviewer.ts`).

A Jev-backed router was designed to move dispatch decisions out of the frontier model. The owner chose active routing from day one over a shadow phase, and chose to extend `herdr_launch` with batch semantics rather than add a separate advisory tool.

## Decision

- **Auto-only batch inside `herdr_launch`.** A request with `assignment` and no `profile` is a batch: the router decides roles, counts, and runners. A request with a named `profile` is today's explicit single launch, unchanged — that is the only guardrail (the escape hatch). There is no role allowlist and no fan-out cap.
- **One `systemOne` call over the flat catalog.** Per role: a `noul` (is this role useful for the task?), a `score` (how many agents, scale 1–5 — answer space, not a policy cap), and a `choice` (which runner among that role's profiles). All questions are parallel and independent; a deterministic policy assembles assignments `{profile, count, purpose}` and ignores runner choices for roles answered "no". State carries the assignment and a compact catalog projection (name, description, runner, model, timeout); tool lists and profile bodies are not sent.
- **Whole-decision confidence threshold 0.8.** Any component below 0.8, or a Jev transport failure, abstains the entire decision: nothing launches, the result is a typed abstain, and the manager delegates as it does today via explicit launches. The router never falls back to a default profile; inventing one would violate ADR-008.
- **Best-effort batch, no rollback.** Children launch independently with full ADR-008 launch evidence and bounded fallback; a router-chosen profile enters its own existing fallback chain as head. Partial failure is reported per child; already-launched children keep working. There are no transactional semantics.
- **Child names derive from the caller's `name` plus role** (`oom-hunt-scout-1`, `oom-hunt-scout-2`). Names are exact targets across `herdr_wait`, `herdr_communicate`, and close; collisions are typed errors.
- **Stateless routing with a local JSONL decision log.** Each decision records state digest, probabilities, assignments or abstain reason. Outcomes join later from job history. No decision IDs, no stored decision resources.
- **Caller policy unchanged (ADR-030).** Auto routing is available to exactly the callers that may launch today.
- **The wait reviewer threshold stays 0.5.** The 0.8 threshold is router-only. Raising the reviewer threshold would increase `unknown` classifications and therefore manager attention wakes — the opposite of the intended noise reduction.

## Alternatives considered

### Advisory `herdr_route` tool called before launching

Rejected: it depends on the manager choosing to ask (the opposite of the mandatory-at-the-harness principle), and fan-out — decided before the first launch — still had no home.

### Shadow phase before granting authority

Rejected by the owner: dogfooding is the acceptance test. The JSONL log still yields the dataset a shadow phase would have produced, so a later threshold/cap/allowlist revision can be evidence-based.

### `profile: "auto"` sentinel for single launches

Rejected: fan-out cannot live inside a single launch, and two routing surfaces would split one decision into two semantics.

### All-or-nothing batch with rollback

Rejected: transactional semantics over lifecycles that were never transactional; closing already-working agents is destructive.

### Role allowlist (never route manager/promoter) and fan-out caps

Rejected by the owner for v1: routing may select any role in the catalog at any count the score yields.

## Consequences

- `herdr_launch` now owns routing: its schema, evidence, and tests carry the new mode. Profile-only launch (ADR-008) still holds — the router selects from the same validated catalog and never widens what can be launched.
- Wrong routes execute for real. The decision log plus dogfooding is the only routing evaluation until the dataset says otherwise.
- Unit tests cover the schema, deterministic policy, catalog projection, and Jev response parsing per repo standard; dogfooding validates routing quality, which tests cannot measure.
