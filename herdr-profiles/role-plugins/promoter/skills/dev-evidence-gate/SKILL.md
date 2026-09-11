---
name: dev-evidence-gate
description: >-
  Decide whether Courier work has the required development deployment and representative smoke
  evidence. Use before marking a PR ready, before merging to staging, before the first staging or
  production execution of a new path, when reusing smoke evidence after a rebase or squash, or when
  asked whether a change must be redeployed.
---

# Dev Evidence Gate

This skill is the authority for the dev-deployment and smoke-evidence gate. Nothing enforces it at a
tool chokepoint — it holds because you read it before calling work review-ready or merge-ready.

## Classify the change

1. For code or infrastructure, require a development deployment and a representative smoke before
   review-ready. For privileged IAM, infrastructure-binding, or execution-path changes, require that
   validation before merging to staging.
2. Before the first staging or production execution of a new execution path, run an end-to-end test
   in dev through the path's real entrypoint. A build, synth, health check, or refusal alone is not E2E.
3. Documentation, agent/workflow policy, and other changes that cannot affect deployed application or
   infrastructure behavior are deployment-exempt. Do not invent a dev gate for those changes.

## Required order

Name the intended entrypoint and discriminating success signal before deployment, then require:

1. exact-head deploy;
2. deployment receipt/readback;
3. representative changed-path E2E;
4. cleanup or absence proof;
5. only then READY/merge qualification.

Infrastructure readback never substitutes for E2E. A seam-scoped `PASS` is valid only when downstream
dependencies are explicitly owned or excluded and the owner accepts that boundary.

## Acceptable evidence

- Bind the evidence to the PR and the surface it exercises: environment, deployed change, entrypoint,
  expected behavior, observed result, and cleanup/health result.
- A representative smoke executes the changed behavior through its intended public or service
  entrypoint. A health endpoint, direct database query, or unrelated test is not a substitute.
- A refusal-path or inertness result can prove only that the refusal/inertness behavior is safe; it
  does not prove that the execution path works.

## Carry-forward and invalidation

- Smoke evidence may carry across a rebase, squash, or remediation only within the same PR and only
  when it still covers the relevant surface.
- Evidence never carries between PRs. Do not cite another PR's deploy or smoke as this PR's evidence.
- If the changed surface is the surface the old smoke was meant to prove, the old evidence does not
  cover it: deploy and exercise that surface again.
- If the environment is inert, receives no representative traffic, or cannot distinguish the old
  path from the new one, mark the smoke vacuous rather than calling the gate passed.

## Honest substitutes

When the normal smoke is vacuous, choose an active feature-native authenticated or deterministic
contract smoke that exercises the same behavior and records a discriminating success signal. If no
safe representative substitute exists, report the dev-evidence gate blocked; never promote a health
check or a zero-traffic no-op into execution evidence.

## Gate result

Report `PASS` only when the applicable deployment and smoke evidence is present, scoped to this PR,
and representative of the changed path. Report `EXEMPT` only for a non-deployed change. Otherwise
report `BLOCKED` with the missing deployment, entrypoint, behavior, or discriminating evidence.

## Lessons 2026-08-25

- A release validation must include an authenticated functional smoke through the changed path. An
  inertness readback on a production-only flag is vacuous for functionality: it proves only that the
  path is inactive, not that export, import, or another runtime behavior works.
- `sync-release-author-approvals` requires approval from every included PR author before a release is
  ready. A teammate may close and re-cut the release PR, which resets the selected commits/approvals;
  re-arm the monitors and recompute the approval set after every re-cut.
- Courier release delivery is merge-commit-only. A normal `BEHIND` state requires rebase onto the
  current base; the repository's carried approval remains valid after that rebase, subject to the
  repository's ordinary current-head checks.

## Lessons 2026-09-06 — what a dev deploy cannot prove

- **An environment-only change cannot be proven in dev.** The single-Lambda dev path is code-only
  (see [shared-dev-deploy](../shared-dev-deploy/SKILL.md)), so a per-function deploy of an env-only fix
  reports success and skips the update; a full dev deploy proves only that dev's own values fit. Dev
  values are systematically shorter than staging and production. For an env-only change, name the
  deploy that will actually prove it (the staging deploy) and say so in the gate result instead of
  reporting a dev PASS.
- **Resolved-environment budget is a per-function, per-stage, per-region measurement.** Lambda's limit
  is 4,096 bytes of `Σ len(key)+len(value)` over the resolved environment. Measure every function a PR
  touches in staging AND production before the PR is ready — not the source-YAML byte proxy, and not
  dev alone. Require ≥ 300 bytes of margin. C-18961 A3b-3 added ~115 bytes to two workers, passed a
  dev check at 3,450 bytes, and failed the staging deploy at 4,148 bytes, leaving the whole staging
  branch undeployable for every team until a fix-forward merged.
- **Runtime handler contracts are invisible to CI.** Unit tests call handlers directly, so `tsc`, Jest
  and the required checks all pass while the Lambda runtime refuses the function at init (Node 24
  rejects an exported handler whose arity is ≥ 3 with `Runtime.CallbackHandlerDeprecated`; every
  invocation dies before user code). For any change to a handler wrapper or exported handler
  signature, require an explicit exported-signature test in the plan and treat the first real deploy
  as the gate.
- **A brief that pins a design gate must cite the design version.** A smoke brief written against
  design v0.1 fail-closed a lane on a `DD_SITE` binding that design v0.3 had deliberately dropped.
  When the design version changes, re-derive every brief that quotes its gates.

## Lessons 2026-09-09 — reuse after rebases, and the cost line
- Smoke-evidence reuse is PATH-scoped: `git diff <deployed-head> <pr-head> -- <the PR's changed paths>` empty ⇒ the evidence carries; the whole-tree difference from unrelated base merges (or a GitHub stacked-PR auto-rebase) is not a reason to redeploy. Record deployed head, PR head, and the empty path-scoped diff in the PR body.
- A branch marked NOT_PROVEN because no dev candidate exists (e.g. no definitive provider error in the dev tenant) is reported as such — never manufacture the failure; the owner decides READY on unit coverage + the proven branches.
- Every dev-evidence option carries its cost line for the owner: wall-clock (exact-head full dev deploy ≈ 17 min + observation), the shared dev lock, and ≈ $0 in AWS. The owner may waive per PR; config-only PRs that only widen safety margins are the usual waiver case, live-consumer resizing is the usual "run it" case — and the smoke can disprove the PR's own arithmetic (it did: 50-record batches ran 6 s, not 0.66 s).

## Lessons 2026-09-10 — post-merge DEV proofs and lane-scoped deploy judgment
- GitHub deletes the PR head branch at merge. A DEV proof dispatched after the merge with `deploy-dev.yml --ref <branch>` fails on "ref not found": run the proof before merging, or recreate the ref (`git push origin <sha>:refs/heads/<branch>`) — a fast-forwardable merge has the same tree as the head, so the proof still covers what staging carries (C-20711).
- Judge a deploy by the job that carries the changed app plus a positive readback (`describe-stacks` LastUpdatedTime after the run start, LIVE alias/definition assertions), never by the workflow aggregate. On staging an unrelated app's failure leaves the workflow red while the arm64 job has deployed; on DEV the arm64 job is skipped when the AMD64 job fails, so nothing deployed — the same red means opposite things.
- A `PASS` recorded from a proof that reached the changed step (e.g. `AuditExport READY`) and then stopped on a known, pre-declared fixture outcome is complete for that PR; state the known stop in the report so it is not read as a new failure.
