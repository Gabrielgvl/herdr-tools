# Herdr Tools

A Pi extension that turns the Herdr terminal multiplexer into a supervised multi-agent runtime. This glossary fixes the language used across SPEC.md, the ADRs, and the code.

## Language

### Delegation

**Task**:
The one caller-authored unit passed to `herdr_launch`: an objective, scope, completion evidence, caller constraints, and optional routing or recovery policy. One call launches one Task, with optional isolated replicas.
_Avoid_: spec, assignment, profile, role, preset, template

**Task contract**:
The Task's single semantic authority: `objective`, `scope`, `doneWhen`, and `constraints`. The contract feeds child rendering, Jev, and the assignment-budget preflight; supervision receives the digest — `objective`, `doneWhen`, `constraints`, never `scope`.
_Avoid_: instructions, supervision digest, verification field, prompt body

**Quality tier**:
A starting quality and compute posture: `utility`, `economy`, `standard`, `strong`, `frontier`, or `max`. The workload floor sets the effective start; a caller's explicit tier may raise it by at most one tier, and recovery starts at least one tier above the prior route.
_Avoid_: category, class, profile family

**Workload profile**:
The routing description of a Task across `intent`, `mutation`, `scope`, `horizon`, `verifiability`, `workspaceState`, and `ambiguity`. Jev supplies `intent` (its top choice, regardless of confidence), runtime evidence supplies `workspaceState`, and `verifiability` derives from the done-when gate; the remaining fields are fixed placeholders. Shape labels have no policy authority.
_Avoid_: workload shape, role, task type

**Operating point**:
A reviewed runner, model, and native reasoning-setting combination that routing may select. Relative cost and latency are catalog facts; quality tier suitability is contextual to each route.
_Avoid_: model, model configuration, runner default

**Candidate**:
One admissible operating point considered inside a deterministic quality-tier and recovery bucket. The catalog's authored chain order from the effective tier upward is the pre-execution fallback chain; candidates are never model-ranked.
_Avoid_: profile, model pick, runner choice

**Recovery lineage**:
The `recoveryOf` link from a new Task to a prior managed handoff run. Runtime resolves the prior run's workspace, state, and route evidence; recovery is not fallback or a workload intent.
_Avoid_: retry, recovery role, failed profile

**Replica**:
One of the `replicas` children created from a Task. Replicas share one routing contract and use isolated Git worktrees.
_Avoid_: fan-out, copy, clone

**Launch ID**:
The runtime-generated identity of one `herdr_launch` operation. Callers do not author launch or child machine names.
_Avoid_: name, launch name, batch name

**Child target**:
The runtime-generated exact identifier returned for one launched child. Communication, waits, jobs, and lifecycle operations target this value rather than a human label.
_Avoid_: child name, task label, pane label

**operatingPointId**:
The public evidence field naming the exact runner, model, and reasoning configuration that bound and started a child.
_Avoid_: candidateName, profileName, model

**requestedOperatingPointId**:
The public evidence field emitted only when pre-execution fallback changed which operating point started the child. It is omitted when equal to `operatingPointId`.
_Avoid_: requestedCandidateName, requestedProfileName, originalProfile

**Label**:
Optional presentation metadata for a Task. A label may repeat and never affects routing, revision, tab selection, machine identity, or target resolution.
_Avoid_: name, target, task ID

**Workload tab**:
A same-workspace tab whose exact label follows `workload:<intent>` or `workload:<intent>:<number>`. Runtime-created tabs use one row and hold at most four total panes. A pre-existing exact-label tab may be reused by pane-count proxy when non-focused geometry cannot be inspected. The owning manager handles cleanup.
_Avoid_: role tab, task tab, placement

**Reviewer**:
Judges a running child's progress from transcript evidence into one of progress, stalled, blocked, risk, appears_complete, unknown. The supervisor reviewer is Jev (`typesafe/jev-latest`): six `noul` predicates plus a `reason` choice reduced by `reduceSupervisionReview`.
_Avoid_: router, judge, verifier

### Routing

**Jev**:
TypeSafe's decision-only model: typed questions in, calibrated probabilities out, no generated text. It supplies Task evaluation (done-when gate, workload intent, weakest sufficient tier), supervisor review, and optional explicit wait review.
_Avoid_: classifier, LLM

**doneWhen**:
The Task's concrete, externally judgeable completion conditions. They are the only caller-authored completion authority used by both launch admission and supervision.
_Avoid_: verification, supervision digest, success spec, checklist

**Task decision**:
The per-Task output after deterministic policy is applied to Jev judgments: admitted, rejected by the done-when gate, or a typed abstention. One record is appended to `.herdr/router/decisions.jsonl` before the first child mutation.
_Avoid_: spec decision, RouteDecision, recommendation, suggestion, plan

**Abstain**:
The router declining to launch with zero launch effects, for example an oversized evaluation request, no available candidate in the chain, invalid response, unavailable catalog, authentication failure, transport failure, or abort.
_Avoid_: unknown, fallback, rejection
