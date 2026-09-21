# Herdr Tools

A Pi extension that turns the Herdr terminal multiplexer into a supervised multi-agent runtime. This glossary fixes the language used across SPEC.md, the ADRs, and the code.

## Language

### Delegation

**Spec**:
A caller-authored launch unit in `herdr_launch.specs`: `label`, `instructions`, a typed `assignment` (`objective`/`scope`/`verification`), optional `category`, optional replica `count`. Specs replaced profiles and roles in the ADR-035 migration; the words "profile" and "role" describe only deleted machinery.
_Avoid_: profile, role, preset, template

**Category**:
The public `specs[].category` field names a catalog capability group (`frontier`, `balanced`, `cheap`) that resolves to an ordered chain of `{runner, model}` candidates in `herdr-profiles/catalog.yaml`. A spec may name its category; otherwise Jev chooses it. The current schema has no `qualityTier` field and no `standard` default.
_Avoid_: quality tier, tier, class, profile family

**Candidate**:
One `{runner, model}` entry in a category chain. Deterministic admission selects the first eligible and available candidate; the rest remain the fallback chain inside `agent_start`.
_Avoid_: profile (deleted), model pick, runner choice

**candidateName**:
The public `herdr_jobs` projection field carrying the model of the candidate that actually bound and started the child (under `request.child`, `supervision.child`, `supervision.provisional`).
_Avoid_: profileName (retired), model, runnerName

**requestedCandidateName**:
The public `herdr_jobs` projection field emitted only when chain fallback changed which candidate started the child — it carries the candidate recorded at reservation and is omitted when equal to `candidateName`.
_Avoid_: requestedProfileName (retired), originalProfile

**Reviewer**:
Judges a running child's progress from transcript evidence into one of progress, stalled, blocked, risk, appears_complete, unknown. The supervisor reviewer is Jev (`typesafe/jev-latest`): six `noul` predicates plus a `reason` choice reduced by `reduceSupervisionReview`. Not the router.
_Avoid_: router, judge, verifier

**Label**:
One field name, two scopes: a request-level `label` is the pane label shown in the mux, while a spec-level `label` is the caller's name for the spec that derived child names (`{name}-{spec.label}-{N}`) are built from. Neither is renamed; the overload is ratified.
_Avoid_: pane-label, spec-name — the field is spelled `label` at both levels

### Routing

**Jev**:
TypeSafe's decision-only model: typed questions in, calibrated probabilities out, no generated text. Serves spec evaluation (`jev-latest`), the supervisor reviewer (`typesafe/jev-latest`), and — when configured with `typesafe/<model>` — the explicit wait reviewer.
_Avoid_: classifier, LLM

**supervisionDigest**:
The required request-level authorial digest — `doneWhen` plus `constraints` — recorded at supervision reservation and supplied to every supervisor review as the judgeable completion contract.
_Avoid_: done criteria, success spec, checklist

**Spec decision**:
The per-spec output of `routeSpec` after deterministic policy is applied to Jev's judgments: admitted (selected candidate plus fallback chain), rejected (quality gate), or a typed abstention. One record is appended to `.herdr/router/decisions.jsonl` before the first child mutation.
_Avoid_: RouteDecision (retired), recommendation, suggestion, plan

**Abstain**:
The router declining to launch a spec — `low_confidence`, `no_assignments`, `catalog_unavailable`, `invalid_response`, `authentication_unavailable`, `transport_failed`, `aborted` — with zero launch effects.
_Avoid_: unknown (reserved for the reviewer), fallback (reserved for candidate chains)

**Replica**:
One of the `count` children a spec expands to. Replicas share the spec's instructions and selected chain, get deterministic `{name}-{spec.label}-{N}` names, and — when `count > 1` — launch into isolated worktrees under `.herdr/worktrees/`.
_Avoid_: fan-out (role-derived fan-out is deleted), copy, clone
