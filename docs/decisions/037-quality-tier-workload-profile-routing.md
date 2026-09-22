# ADR-037: Task-contract quality-tier routing

## Status

Accepted.

## Date

2026-09-21

## Context

ADR-035 replaced role and profile routing with caller-authored specs and three static categories. The public launch request still describes the same work several times through `instructions`, `assignment.objective`, `assignment.scope`, `assignment.verification`, and request-level `supervisionDigest`. The manager must also supply naming, placement, focus, and delivery details that the runtime can own.

That duplication caused real launch failures during the ADR-037 Herdr Flow. It also permits child instructions, Jev evaluation, and supervision to judge different contracts.

The three categories have a separate problem. Each category combines the caller's quality and compute posture with the assignment's intent, mutation, scope, horizon, verifiability, state, and ambiguity. Adding more category names would keep those dimensions entangled. Hand-authoring every tier and workload chain would recreate the deleted profile matrix.

The required shape is smaller:

- one caller-authored Task contract per launch call;
- one optional quality tier;
- an orthogonal runtime-derived workload profile;
- reviewed operating points behind deterministic policy;
- runtime-owned identity, topology, delivery, supervision, and evidence.

## Decision

### Public contract

`herdr_launch` launches exactly one Task per call. Its complete public input is:

```ts
interface HerdrLaunchParams {
  objective: string;
  scope: string;
  doneWhen: string[];       // 1..8
  constraints?: string[];   // 0..8, default []

  tier?: QualityTier;       // default "standard"
  replicas?: number;        // integer 1..8, default 1
  recoveryOf?: string;      // managed handoff run ID

  label?: string;           // display metadata only
  cwd?: string;             // any accessible directory
}
```

The schema is strict. Unknown fields fail validation. Text fields are nonempty and reject NUL. `doneWhen` requires one to eight entries. `constraints` accepts zero to eight entries. The rendered payload retains one authoritative UTF-8 byte limit instead of unrelated per-field text limits.

These public fields are deleted:

```text
name
specs
tasks
instructions
assignment
supervisionDigest
category
count
placement
focus
assignmentDelivery
workload overrides
```

There is no compatibility alias. In-flight and historical records retain their original representation and are never passed through the new parser.

### Task

Task is the canonical caller-authored unit. Spec and Assignment are retired as public domain terms.

The semantic Task contract is exactly:

```text
objective
scope
doneWhen
constraints
```

The same values feed:

1. deterministic child instruction rendering;
2. Jev evaluation;
3. caller-required resource checks;
4. supervision reservation and review;
5. bounded decision evidence.

The universal baseline remains a separate trusted system block. It owns platform conduct such as single-writer behavior, contract preservation, evidence reporting, delegation limits, and handoff obligations. Callers do not repeat those rules.

`constraints: []` means no caller-specific constraints beyond the universal baseline.

### One Task per call

There is no public Task array and no batch composition decision. A coordinator composes a team through separate launch calls.

The B13 `missing_area` planned-team advisory is deleted because one launch no longer carries a complete planned team. The router never invents scouts, reviewers, recovery children, or any other team member.

Replicas remain inside one Task because they repeat one contribution rather than add distinct team contributions.

### Quality gate

`done_when_verifiable` is the only semantic launch-quality gate. It judges whether `doneWhen` contains concrete, falsifiable completion evidence relevant to the Task's `objective` and `scope`.

A confident bad answer rejects the Task. A passing answer remains `not_rejected`, never a certification. Nonempty `objective` and `scope` are schema requirements, but there is no separate `instructions_adequate` or `task_contract_adequate` Jev gate.

### Quality tiers

A quality tier is the caller's requested starting quality and compute posture:

```text
utility < economy < standard < strong < frontier < max
```

Omission means `standard`.

| Tier | Routing objective |
| --- | --- |
| `utility` | Minimize cost and latency while accepting later recovery escalation. |
| `economy` | Optimize cost per successful completion. |
| `standard` | Optimize expected total cost per accepted result. |
| `strong` | Bias toward first-pass completion. |
| `frontier` | Strongly bias toward completion reliability. |
| `max` | Maximize success probability within reviewed limits. |

A requested tier below the workload floor is raised automatically. Evidence records the requested tier, workload floor, and effective tier. A requested tier above the normal recovery ceiling remains allowed and raises the effective ceiling to at least the effective start.

### Workload profile

There is no authoritative flat workload-shape enum. The routing profile is:

```ts
interface WorkloadProfile {
  intent: "explore" | "reason" | "implement" | "debug" | "verify" | "review" | "coordinate";
  mutation: "none" | "bounded" | "broad";
  scope: "local" | "multi_file" | "repo_wide";
  horizon: "short" | "medium" | "long";
  verifiability: "strong" | "partial" | "weak";
  workspaceState: "clean" | "partial" | "failed";
  ambiguity: "low" | "medium" | "high";
}
```

Jev derives every semantic field except `workspaceState`. Runtime lifecycle and handoff evidence supply `workspaceState`. Caller prose cannot override it.

A workload choice below `0.8` confidence abstains before topology or launch effects. The abstention names the uncertain dimensions. The caller clarifies the canonical Task contract and submits a new launch. There is no classification receipt and no public workload override.

### One Jev request

The migration retains one `systemOne` request per Task. The request uses the raw canonical Task, requested tier, runtime state, reviewed operating-point metadata, and catalog resource projections.

It contains:

- `done_when_verifiable`;
- six closed workload choices;
- runner-qualified resource Nouls;
- six tier-specific fitness Nouls for every statically admissible operating point.

The six speculative fitness judgments avoid sibling-answer dependency. After workload policy computes the effective tier, the router consumes that tier's fitness Noul for each point.

Fitness is a ranking signal, not an admission gate. If all policy-admissible points have low fitness, the highest value still ranks first. D2 records the judgments for later calibration.

Resource requirements explicitly named anywhere in `objective`, `scope`, `doneWhen`, or `constraints` cannot silently disappear because Jev excluded the resource.

### Operating points

An operating point is one exact runner, model, and runner-native reasoning-setting combination. The catalog generates each runner's reviewed model set by its runner-supported reasoning-setting cross product.

Every exact point requires reviewed metadata:

```ts
interface OperatingPointPolicy {
  id: string;
  costClass: "low" | "medium" | "high" | "extreme";
  latencyClass: "low" | "medium" | "high" | "extreme";
}
```

Missing or duplicate metadata makes the catalog invalid. Runtime support for a reasoning setting never grants capabilities, tools, resources, permissions, authorization, or account access.

Tier envelopes are:

| Tier | Maximum cost | Maximum latency |
| --- | --- | --- |
| `utility` | `low` | `low` |
| `economy` | `low` | `medium` |
| `standard` | `medium` | `medium` |
| `strong` | `high` | `high` |
| `frontier` | `extreme` | `extreme` |
| `max` | unbounded | unbounded |

An operating point has no intrinsic quality tier.

### Workload tier policy

Intent supplies the base interval:

| Intent | Base floor | Base ceiling |
| --- | --- | --- |
| `explore` | `utility` | `standard` |
| `reason` | `economy` | `frontier` |
| `implement` | `standard` | `frontier` |
| `debug` | `standard` | `max` |
| `verify` | `utility` | `standard` |
| `review` | `standard` | `frontier` |
| `coordinate` | `standard` | `frontier` |

Each value below adds one tier to the admission floor:

- `mutation = broad`;
- `scope = repo_wide`;
- `horizon = long`;
- `ambiguity = high`;
- `workspaceState = partial` or `failed`.

The increments accumulate and cap at `max`. Weak verifiability does not raise the floor.

Any difficult semantic modifier raises the base recovery ceiling by one tier. `workspaceState = failed` raises it to `max`. If the adjusted floor or explicit requested tier exceeds the adjusted ceiling, the effective ceiling rises to the effective start.

### Deterministic authority

Deterministic code owns:

- reviewed model and reasoning membership;
- runner compatibility;
- authorization and account eligibility;
- capability, resource-pool, permission, and execution-policy limits;
- tier cost and latency envelopes;
- workload floor and ceiling calculation;
- recovery lineage and exclusions;
- dynamic availability filtering;
- the four-attempt fallback bound.

Jev supplies semantic workload, resource, and operating-point fitness judgments within those bounds. The compiler remains the final security and capability authority.

### Pre-execution fallback

The chain remains bounded by `maxAttempts = 4` and contains points from the effective start tier only. It never widens into a stronger tier.

Ordering is:

1. highest-fitness available point;
2. providers not already represented;
3. remaining points by fitness;
4. stable `operatingPointId` tie-break.

If the effective tier has no available point, routing abstains with `no_candidates_at_tier`.

The initial availability filter runs after fitness scoring. Availability is rechecked immediately before every start attempt across the entire fallback loop. A point that becomes unavailable is skipped without another Jev request. Fallback remains limited to the established safe pre-execution failure envelope.

### Runtime identity

Callers do not name launches or children. Runtime generates stable `launchId` and child target IDs. Returned child targets are the only exact identifiers accepted by communication, wait, jobs, and lifecycle operations.

`label` is optional presentation metadata. It may be repeated. It does not affect routing, Jev state, Task revision, machine identity, tab selection, or target resolution.

`operatingPointId` names the exact runner, model, and reasoning configuration that started a child. It replaces model-only `candidateName`. `requestedOperatingPointId` replaces `requestedCandidateName` when pre-execution fallback changes the started point.

### Runtime topology

Callers do not select placement or focus behavior.

Every child stays in the caller's current Herdr workspace. After workload classification, runtime groups panes by workload `intent` into canonical tabs:

```text
workload:<intent>
workload:<intent>:2
workload:<intent>:3
```

Runtime-created workload tabs use right splits, so they remain one row. Runtime reuses one when its label exactly matches that grammar and it has fewer than four total panes.

For a pre-existing exact-label tab, Herdr cannot inspect non-focused tab geometry without changing visible focus. Runtime therefore uses the exact label and pane count as a reuse proxy, and records that the layout was not verified. All panes count, including human shells and unrelated panes. Runtime never closes, replaces, or moves an existing pane to make room.

When every matching tab is full, runtime creates the next numbered tab. Replicas may span numbered workload tabs in groups of four.

Launch never closes completed panes or tabs. The owning manager performs cleanup after reviewing ownership and state.

### Working directory

`cwd` may be relative or absolute. Runtime canonicalizes symlinks, requires an existing accessible directory, and records the resolved path before effects. It is not restricted to the manager root or a registered project root. Filesystem and tool permissions remain compiler and operating-system concerns.

### Replicas

`replicas` defaults to one and is capped at eight. One routing evaluation and one fallback contract serve every replica.

More than one replica requires a Git repository where Herdr can create isolated worktrees. If isolation cannot be proven before effects, launch fails closed. Replicas never share one writable checkout.

### Recovery

A coordinator launches recovery by authoring a complete new Task with `recoveryOf`. There is no recovery tool and no automatic retry.

`recoveryOf` names the managed handoff run ID of the failed child. Runtime resolves the prior route tier, operating point, policy revision, workload profile, lifecycle state, workspace, and handoff evidence.

Recovery rules are:

- `replicas` must be one;
- `cwd` is forbidden;
- runtime resumes the prior managed workspace or fails closed;
- effective start is the maximum of requested or default tier, adjusted workload floor, and the next tier after the prior route tier;
- at `max`, the next tier remains `max`;
- the failed operating point is excluded;
- a different provider ranks ahead of the failed provider when an eligible alternative exists.

A started-child failure never invokes the pre-execution fallback chain.

### Delivery

Callers do not choose inline or attachment delivery. Runtime renders the canonical Task, measures UTF-8 bytes, uses inline delivery when it fits, and automatically uses attachment delivery otherwise. It rejects before effects if no supported delivery can carry the Task.

### Uniform result

Every call returns one result shape:

```ts
interface LaunchResult {
  kind: "launch";
  launchId: string;
  outcome: "abstained" | "launched" | "partial" | "failed";
  requestedTier: QualityTier;
  effectiveTier?: QualityTier;
  children: Array<{
    target: string;
    state: string;
    operatingPointId?: string;
    supervisorJobId?: string;
    worktree?: string;
    error?: { code: string; message: string };
  }>;
}
```

One replica produces a one-element `children` array. Partial replica failure keeps successful children running and never rolls them back. Errors remain bounded and redacted.

Detailed workload probabilities, fitness judgments, exclusions, availability, and compiled contracts remain in the decision log and jobs evidence rather than the immediate launch response.

### Logs and learning

The decision log records bounded, non-secret evidence for:

- requested tier, workload floor, effective start, and ceiling;
- workload choices, probabilities, and confidence;
- consumed fitness judgments;
- operating-point metadata and deterministic exclusions;
- the generated chain and selected point;
- availability and recovery evidence;
- catalog and policy revisions.

Caller text, resource bodies, credentials, raw provider responses, and exception messages remain excluded.

D2 joins outcomes to this evidence and proposes versioned policy or catalog revisions. Humans approve production changes. There is no online policy learning.

## Migration

This is one hard cutover after draining in-flight launches.

- Rewrite `LaunchSpecSchema`, `LaunchAssignmentSchema`, and `SupervisionDigestSchema` as the flat Task schema.
- Delete batch composition and `missing_area` machinery.
- Replace child-name derivation with runtime launch and child IDs.
- Replace caller placement with workload-tab placement after workload classification.
- Move reasoning settings from runner defaults into operating points.
- Version-bump persisted handoff state before adding recovery route evidence.
- Rename candidate evidence to operating-point evidence in the same cutover.
- Regenerate bundled skills and replace category, spec, assignment, naming, placement, and result guidance.
- Preserve old records without reinterpretation.

The implementation DAG must carry two pertinent plan-review findings:

1. recheck availability before every start attempt in the whole fallback loop;
2. migrate every catalog consumer and fixture in the same node as the catalog version/type cutoff.

The repository has no changelog file, so the migration does not invent one.

## Alternatives considered

### Keep the current split contract

Rejected. It preserves several authorities for one Task and already causes avoidable launch failures.

### Keep a Task array

Rejected. The caller chose one Task per call. Team composition belongs to the coordinator across calls.

### Add a separate recovery tool

Rejected. Recovery still needs a complete new Task. A separate tool would duplicate the contract or encourage blind retry.

### Keep caller placement

Rejected. Workload intent is already known before topology mutation. Runtime can group children consistently without making managers script pane layout.

### Use classification override receipts

Rejected. A low-confidence caller clarifies the canonical Task and launches again. Workload fields remain runtime-derived.

### Switch to two Jev phases now

Rejected for this migration. The simpler public contract does not require reopening the internal routing architecture. The one-call speculative design must be measured. A later two-phase classifier and ranker can remain behind the same public contract.

### Keep human labels as targets

Rejected. Presentation text should not create machine identity constraints, collisions, or label-length failures.

## Consequences

- The caller-facing contract becomes one flat Task with four semantic fields and five optional policy, lineage, presentation, or filesystem fields.
- Team launches require separate calls. The composition advisory disappears.
- Managers must retain returned child target IDs instead of predicting names.
- Topology becomes workload-aware and runtime-owned. Exact canonical tab labels opt an existing tab into reuse by pane-count proxy when non-focused geometry is unavailable.
- Arbitrary accessible `cwd` values are permitted. This does not grant capabilities beyond the process user's access and compiled policy.
- Vague objective or scope text has no independent semantic quality gate. The done-when gate checks relevance, and uncertain workload classification abstains.
- The one-call design can ask approximately six times the operating-point count in fitness questions. Request size, latency, and held-out route agreement remain required migration measurements.
- Weak inherent verifiability can launch only when its concrete `doneWhen` evidence passes the gate.
- Recovery remains explicit lineage and never creates concurrent writers over partial state.
- The accepted public contract can later front a two-phase router without another API migration.

This ADR supersedes ADR-035's public spec, assignment, batch, supervision-digest, category, naming, placement, delivery, and composition-advisory decisions. It preserves deterministic compiler authority, caller-owned composition, availability admission, phased attempts, bounded pre-execution fallback, isolated replicas, and explicit post-start recovery.
