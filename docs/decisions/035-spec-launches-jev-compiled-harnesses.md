# ADR-035: Caller-authored specs with Jev-compiled harnesses

## Status

Accepted.

**Amended 2026-09-18 (owner-directed):** caller-authored specs REQUIRE `doneWhen` (1–8 items, non-empty) and `constraints` (1–8 items, may be `["none"]`) as mandatory fields. The supervision reviewer's evidence gate (ADR-034) grounds its judgment on them; a spec without done-when conditions is unjudgeable by design and must fail launch validation, not produce ungrounded review wakes. The optional shape inherited from ADR-034's interim field is superseded by this required form.

## Date

2026-09-18

## Context

The 24-file role × runner profile matrix exists because the runner is baked into each profile's identity: `worker-pi`, `worker-claude`, `worker-devin`, `worker-agy` differ almost entirely in their runtime block. Inspection showed the profile bodies carry little unique competence — the skills hold the behavioral content — and the runner choice forces callers to know implementation details a scheduler should own.

ADR-032's router was built to move composition decisions (which roles, how many) off the frontier model — but that optimizes the wrong axis. The expensive decision is not *which role*; it is *which runner, model, and resources* for a given piece of work, and that decision has real-time inputs (quota, account windows, health) a static catalog cannot see.

Harness Protocol's profile schema was evaluated as the replacement format and rejected: once profiles are deleted, what remains — pools, chains, quota sources — is internal machinery no second consumer will read, so spec-valid `policy:`/`x-herdr:` structure would be ceremony around a parser we still write ourselves.

Probes against live Jev validated the mechanism (`scripts/jev-tool-selection-probe.mjs`, `scripts/jev-spec-gate-probe.mjs`, `scripts/jev-spec-gate-probe2.mjs`): per-resource noul selections discriminate cleanly (~1s for ~30 questions, clear separation between selected and rejected tools), and `instructions_adequate`/`assignment_verifiable` separate clearly-lazy specs (0.03–0.12) from adequate ones (0.49–0.73) — but cannot certify quality. An external review endorsed deleting the matrix while requiring the task-instruction / trusted-execution-contract boundary to remain explicit and deterministic.

## Decision

- **The profile model is deleted.** No role files, no `{role}-{runner}` profiles, no `profile` launch parameter. The unit of launch is a caller-authored **spec**: `{label, instructions, assignment{objective, scope, verification}, category?, count?}` inside a request that also requires `supervisionDigest: {doneWhen, constraints, readOnly?}`. `doneWhen` and `constraints` are request-level arrays with 1 to 8 non-empty items each.
- **Composition is the caller's; configuration is Jev's.** The caller composes the team — which specs exist, their labels, their counts. Per spec, one `systemOne` call runs the quality gate, category confirm/override, and runner-qualified resource nouls covering every chain candidate, so a fallback switch needs no second call. This supersedes the role noul/score/choice questions of ADR-032; its batch expansion, child naming, collision handling, and decision log survive.
- **The quality gate rejects confident-bad; it never certifies.** `instructions_adequate` and `assignment_verifiable` reject a spec Jev is confident is inadequate; the passing outcome is named `not_rejected`. Quality rejections are never bypassable and take precedence over abstains.
- **A deterministic compiler owns correctness.** Pool ∩ selection + plumbing is not launchable as-is: the compiler adds declared dependencies, removes incompatibilities, compiles per candidate runner, validates against policy, and records the effective config — installed vs exposed vs permitted are distinct. Jev supplies fitness judgments; it cannot grant, weaken, or invent capabilities outside the pool.
- **Categories hold ordered chains.** A purpose-built catalog config (our own YAML, not Harness Protocol) declares category chains (`frontier: [{runner, model}, …]`), per-runner pools/plumbing/defaults, skill and MCP pools, and quota sources. Resolution picks the first chain member satisfying eligibility — authorization, runner/version compatibility, required resources, account eligibility, execution policy, current admission — filtered by quota; the rest of the chain is the fallback, exercised pre-execution only.
- **A universal baseline rides every launch.** One always-on instruction block — single-writer ownership, contract preservation, evidence reporting, no hidden delegation, uncommitted-handoff — platform obligations, not a persona. Caller instructions are provenance-wrapped so the child can distinguish caller text from system text.
- **The quota monitor observes; the scheduler admits and actuates.** Availability is modeled by provider + billing product + account + scope, not runner name — runners can share an account. Proactive sources where they exist (pi-quotas, claude account windows, devin analytics as coarse evidence only), reactive classified-failure cooldowns as the floor for every runner. Credential actuation is per-session binding (e.g. `cswap run`), never global switching under running sessions. Failure classes distinguish quota / auth / unsupported-config / permission-prompt / transport / task-failure — only the first is quota. Exhausted candidates return a nullable `retryNotBefore` plus evidence, never a fabricated ETA.
- **Attempts are phased.** Pre-spawn failure is safe to retry on the next chain entry; spawned-but-unacked is reconciled by identity, never duplicated; started-then-failed goes to the recovery/handoff path.
- **Abstain is fail-closed; bypass is a receipt.** Transport failure, invalid response, or below-threshold category confidence abstains. A bypass is bound to a recorded abstention — caller, spec revision, policy revision, launch identity — and replay returns the same result. A transport-abstain bypass launches with `quality=not_evaluated` labeled in evidence.
- **Replicas get isolated worktrees.** `count > 1` launches one child per spec in its own worktree; distinct scopes are distinct specs.
- **Composition check is advisory.** `missing_area` flags only at P ≥ 0.8 and is tagged when the launched team differs from the assessed team; it never gates.

## Alternatives considered

### Harness Protocol `harness.yaml` profiles

Rejected: the schema models portable profiles, and profiles are deleted. What remains is internal config; wrapping it in `policy:`/`x-herdr:` buys no portability and adds a spec we must still parse ourselves. It served as the lens that clarified the design.

### Role files as capability ceilings (Jev narrows a reviewed envelope)

Rejected in favor of caller-authored specs: the role bodies were already thin pointers to skills, and a ceiling file per role preserves a catalog the design no longer needs. The universal baseline recovers the irreducible shared contract without resurrecting roles.

### Jev composes the team (ADR-032 role routing)

Superseded: caller-authored specs make composition an input, not a decision. Jev's job narrows to the axis with real-time inputs — resources, category, admission.

### Global credential rotation for quota actuation

Rejected: rotating shared account state under running sessions can break them mid-task. Per-session account binding (`cswap run`-style) confines the mutation to the launching child.

### Hard composition gate

Rejected: probes showed adequate teams score ~0.5 sufficiency with noisy missing-area flags (a typo fix was flagged for missing independent verification at 0.66). Advisory-at-0.8 catches clear gaps (worker-only on a verify task: 0.94) without blocking legitimate work.

### Fallback as a retry mechanism

Rejected: post-start failure means a child already touched state; blind relaunch risks duplicate writers. Chain fallback is pre-execution only; post-start failures go to recovery with evidence.

## Consequences

- **Supersedes part of ADR-032** (role nouls/scores/choices, catalog-projection source) and the profile model of ADR-006/007/008/026. Explicit escape-hatch profile launches are replaced by bypass receipts.
- **Competence drift is bounded, not eliminated.** The gate blocks confident-lazy specs and the baseline carries platform obligations, but a well-worded lazy spec still passes; craft discipline rides on skill-selection fitness.
- **Caller-authored instructions are provenance-marked, not filtered** — upstream content can still flow into agent identity.
- **Read-only is a tendency, not a guarantee** — a "written report" scope scored `write` at 0.31 in probing; scope wording drives tool selection, nothing enforces it.
- **Fitness errors execute for real.** The gate wording was tuned against its own examples, so those numbers are development evidence, not validation — a held-out task set is required before trusting calibration.
- **Promoter-style runner pinning is gone** — chain order and eligibility are the only preferences. All profile-name-keyed behavior must be inventoried before the files are deleted.
- **Migration surface**: `herdr-profiles/*.md` deleted; `role-plugins/*/skills` rehome as the skill pool; parser/types/resolution/adapters rewritten to spec + compiler; `herdr_launch` schema becomes spec/agents; the quota monitor is new. Lands after the router branch merges so its batch expansion is reused.
- **Cutover discipline**: drain in-flight jobs, never reinterpret in-flight records, rollback preserves work and never relaunches through the old path.
