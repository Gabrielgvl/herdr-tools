# ADR-037: Task-contract quality-tier routing

## Status

Accepted. Ratified 2026-09-24 against the shipped implementation at policy revision `adr-037-p3`: the originally migrated speculative design (six workload choices, resource Nouls, per-point fitness Nouls, intent-interval tier policy, four-attempt same-tier chain) was simplified to three questions, a direct weakest-sufficient-tier answer, and catalog-authored chains. The sections below describe the shipped behavior; the superseded design is marked historical where it remains for context.

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

The contract feeds:

1. deterministic child instruction rendering;
2. Jev evaluation;
3. the launch assignment-budget preflight;
4. supervision reservation and review — the digest carries `objective`, `doneWhen`, and `constraints`, never `scope`;
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

A requested tier below the workload floor is raised automatically: the effective start is `max(requested ?? "standard", floor)`. Evidence records the requested tier, workload floor, effective start, and effective ceiling — always `max`, because the chain continues upward through every stronger tier.

### Workload profile

There is no authoritative flat workload-shape enum. The routing profile is:

```ts
interface WorkloadProfile {
  intent: "explore" | "reason" | "implement" | "debug" | "verify" | "review" | "coordinate" | "unknown";
  mutation: "none" | "bounded" | "broad";
  scope: "local" | "multi_file" | "repo_wide";
  horizon: "short" | "medium" | "long";
  verifiability: "strong" | "partial" | "weak";
  workspaceState: "clean" | "partial" | "failed";
  ambiguity: "low" | "medium" | "high";
}
```

Jev classifies `intent`. Runtime lifecycle and handoff evidence supply `workspaceState`. `verifiability` is derived from the `done_when_verifiable` probability. The remaining fields (`mutation`, `scope`, `horizon`, `ambiguity`) are fixed placeholder values (`none`/`local`/`short`/`low`) that keep the evidence shape stable — they are synthetic evidence, not Jev classifications, and drive no tier policy. Caller prose cannot override any field.

Policy revision `adr-037-p3` records the owner-chosen intent rule: Jev's top intent is used verbatim regardless of its scalar confidence. A low-confidence intent no longer abstains and never produces a new `unknown` workload record or a `workload:unknown` tab; `unknown` remains in the vocabulary only so historical persisted evidence stays readable. Offline replay of `adr-037-p2` decision metadata moved 30/109 admitted Tasks from `unknown` to a real intent (0/109 unknown) — a coverage change only; intent accuracy is unlabeled and unmeasured. There is no classification receipt and no public workload override.

### One Jev request

The migration retains one `systemOne` request per Task. The request sends only the semantic Task projection — `objective`, `scope`, `doneWhen`, `constraints` — never the requested tier, runtime state, operating-point metadata, or catalog projections.

It asks exactly three questions:

- `done_when_verifiable` (noul);
- `intent` — a closed choice over the seven real intents;
- `weakest_sufficient_tier` — a closed choice over the six tiers, judged against the tier rubric and explicitly ignoring caller tier or preference, model/provider identity, cost, quota, availability, and chain contents.

A serialized request over 96 KiB abstains `invalid_response` (`request_too_large`) before any model call; the request is never truncated. There are no resource Nouls and no fitness Nouls: the tool surface is deterministic (`runnerResourceSelection`), and Jev never ranks operating points. Resource requirements named anywhere in the Task cannot silently disappear because no model excludes them.

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

The envelopes remain reviewed catalog/policy metadata (`TIER_ENVELOPES`); the shipped router does not filter points by envelope — the authored `tierChains` are the admissible set.

An operating point has no intrinsic quality tier.

### Workload tier policy

Jev's `weakest_sufficient_tier` answer is the workload floor directly. The effective start tier is `max(requested ?? "standard", floor)` and the effective ceiling is `max`: the fallback chain is the deduplicated concatenation of the catalog's authored `tierChains` from the effective start tier upward, in catalog order. A tier chain may repeat providers, and operating points may appear in multiple tiers; duplicate point IDs within one tier chain remain invalid.

The tier question was calibrated 2026-09-24 after live p2 metadata showed bounded Tasks receiving strong floors. The instructions keep the first-attempt-sufficiency target but forbid adding a speculative safety margin, and the economy/standard/strong boundary descriptions were tightened so a bounded local or scoped change with clear requirements lands below strong while work decomposed into dependent stages with known handoffs remains strong. A bounded A/B probe on representative Tasks confirmed the reworded question moved a near-verbatim observed launch contract — a bounded prompt-fix Task that production floored at strong — from strong to standard, while utility, economy, and the multi-stage strong counterexample were unchanged. One observation per cell; no accuracy claim over unlabeled production logs.

Policy revision `adr-037-p4` recalibrates the tier question against labeled production Tasks. p3 still floored about 60% of real Tasks at strong or above against roughly a third under the approved rubric, mostly bounded read-only research, audits, and scouts: every Herdr Task carries reply-channel, permission, and PII boilerplate, and the strong description's "coordination across agents or handoffs" matched the single result report every Task sends. The instruction now treats those operating constraints as not raising the tier unless satisfying one is the hard part of the work (live production systems or data, keeping sensitive data inside a boundary), says one result report is not coordination, and states that a Task whose core work is a frontier trigger keeps that tier even when read-only, small, or fully specified; standard now covers bounded read-only investigation or review within one subsystem, and strong covers orchestrating and gating other agents. Measurement: 180 real `herdr_launch` Tasks (one later excluded as unlabelable from its text) labeled blind by two independent labelers against the approved rubric (interval gold where they differ by one tier, adjudicated beyond), direct `systemOne` calls only. On a fresh 60-Task holdout frozen and pre-registered before any call (2 repeats), p4 against p3: inside the gold interval 85.0% vs 60.8%, within one tier 100% vs 96.7%, mean tier distance 0.150 vs 0.425 (paired bootstrap 95% CI of the difference [−0.375, −0.183]), runs below gold 11 vs 14, runs two tiers below 0 vs 2, strong-or-above floors 44/120 vs 73/120 against 44 in gold; intent and done-when answers unchanged, and the burned 24-case D2 set unchanged at 22/24. The labelers are models, so the gold measures agreement with the rubric as they read it, not first-attempt outcomes. The requested tier still dominates the effective start: on the same holdout, `max(requested, floor)` is strong or above for 85/120 runs under p4.

*Historical:* the migrated design derived the floor from an intent base interval (`INTENT_TIER_INTERVALS`) shifted by one tier per difficult workload modifier, with a matching recovery-ceiling adjustment (`resolveTierPolicy`). The shipped router replaced it with the direct tier question; that machinery remains in `src/routing-policy.ts` but is not on the routing path.

### Deterministic authority

Deterministic code owns:

- reviewed model and reasoning membership;
- runner compatibility;
- authorization and account eligibility;
- capability, resource-pool, permission, and execution-policy limits;
- effective start tier and chain assembly;
- recovery lineage and exclusions;
- dynamic availability filtering.

Jev supplies the done-when gate, workload intent, and weakest-sufficient-tier judgments within those bounds. The compiler remains the final security and capability authority.

### Pre-execution fallback

The chain is the deduplicated catalog `tierChains` order from the effective start tier through `max`; repeated operating points keep their first position. It widens into stronger tiers by construction. It has no fixed attempt cap — the chain length is the bound — and the start loop consumes the emitted order verbatim.

The router probes availability once per candidate and admits the first available point in chain order. Launch then re-probes availability immediately before every start attempt across the whole fallback loop; a point that became unavailable is skipped without another Jev request, and a proven agent-free start failure advances to the next point. Fallback remains limited to the established safe pre-execution failure envelope.

If the chain has no available point, routing abstains with `no_candidates_at_tier` — or `transport_failed` when every probed point is local-capacity-limited.

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
- the routed Task's requested tier is lifted to `max(requested or default, next tier after the prior route tier)` before evaluation, so the effective start is `max(lifted request, Jev floor)`;
- at `max`, the next tier remains `max`;
- every operating point on the failed provider is excluded (`recovery_excluded`), not only the failed point;
- unresolved or non-terminal prior-run evidence fails closed (`RECOVERY_SOURCE_UNRESOLVABLE`) rather than guessing the workspace state.

A started-child failure never invokes the pre-execution fallback chain. When the exact Claude session emits an observed typed post-prompt HTTP 429 (including a blocked child), supervision wakes the manager with a high-priority `provider_limit` event (`code: PROVIDER_LIMIT`, started operating point, and managed handoff `runId`) and records a provider cooldown for later launches. An ordinary work-cycle completion may arrive before this failure signal; the provider-limit event is the later, authoritative diagnosis. It does not close a live child or retroactively change the already-returned `herdr_launch` result. If cooldown persistence fails, the provider-limit event still fires with an `evidence_gap`. Before a managed repair prompt, supervision completes its existing bounded native-write retries; a 429 written after those reads can still be detected later, but cannot retract an already-sent repair. No provider-prose matching or automatic redispatch is permitted.

For manual recovery, get `handoff.runId` from `herdr_jobs get`, close the failed child so the run has terminal lifecycle evidence, and pass that UUID as `recoveryOf` on a complete new Task. A child target or launch ID is not a run ID; omit `cwd` and use one replica. Recovery still follows the tier lift and failed-provider exclusion above.

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

Detailed workload probabilities, tier judgments, exclusions, availability, and compiled contracts remain in the decision log and jobs evidence rather than the immediate launch response.

### Logs and learning

The decision log records bounded, non-secret evidence for:

- requested tier, workload floor, effective start, and ceiling;
- intent and tier answers with probabilities and confidence;
- operating-point metadata and deterministic exclusions;
- the generated chain and selected point;
- availability and recovery evidence;
- catalog and policy revisions (`adr-037-p4` on new records, distinguishing them from historical `adr-037-p2` and `adr-037-p3` measurements).

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
- Vague objective or scope text has no independent semantic quality gate. The done-when gate checks relevance, and a confident unverifiable answer rejects the Task.
- The request is a fixed three-question semantic evaluation independent of catalog size; a serialized request over 96 KiB abstains rather than truncating. The p3 always-top intent rule accepts occasional misleading workload-tab labels for low-confidence classifications; intent accuracy remains unlabeled and unmeasured.
- Weak inherent verifiability can launch only when its concrete `doneWhen` evidence passes the gate.
- Recovery remains explicit lineage and never creates concurrent writers over partial state.
- The accepted public contract can later front a two-phase router without another API migration.

This ADR supersedes ADR-035's public spec, assignment, batch, supervision-digest, category, naming, placement, delivery, and composition-advisory decisions. It preserves deterministic compiler authority, caller-owned composition, availability admission, phased attempts, bounded pre-execution fallback, isolated replicas, and explicit post-start recovery.
