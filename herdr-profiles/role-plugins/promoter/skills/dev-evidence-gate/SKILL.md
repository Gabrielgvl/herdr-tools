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
