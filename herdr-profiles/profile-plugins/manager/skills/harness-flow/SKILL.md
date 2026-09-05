---
name: harness-flow
description: Use when complex work needs phased Herdr agents.
---

# Harness Flow

Run complex engineering work as a visible, profile-backed Herdr flow:

`explore → plan → work → critic → promote`

The manager coordinates. Every phase runs in a separate agent. Models remain profile configuration, not skill policy.

## When to Use

Activate when the task cannot be completed safely and fully by one bounded worker with one objective gate. Typical signals are material ambiguity, multiple DAG nodes or components, independent review needs, or an escalation risk.

Activate when the owner asks for the harness explicitly. Skip when the owner explicitly requests the direct path and no safety boundary requires the full flow.

Do not use for a localized change that one bounded worker can implement and verify end to end.

## Preconditions

1. Require `HERDR_ENV=1`. Outside Herdr, stop and request a new `manager-pi` or `manager-claude` session; never fall back to inline orchestration.
2. Require the typed Herdr profile tools, especially `herdr_inspect`, `herdr_launch`, `herdr_communicate`, `herdr_wait`, and `herdr_jobs`. If they are unavailable, stop rather than using raw CLI control or native hidden subagents.
3. Inspect the current context and profile catalog before launch. A missing or invalid required profile is a blocker.
4. Keep the manager on its isolated tab and use the manager role skill for topology, provenance, supervision, waits, ownership, and cleanup.

## Profile Routing

Pi is primary:

- manager: `manager-pi`; use `manager-claude` only when selected explicitly or for a deliberate manager handoff;
- explore: `scout-pi`, plus `researcher-pi` only when external facts are required;
- plan: `planner-pi`;
- work: `worker-pi`;
- critic: `reviewer-pi`;
- promote: `promoter-pi`.

Use each profile's declared fallback chain. Never hardcode provider or model IDs here. For prewalk, choose the highest-capability approved profile configuration for planning and the first genuinely novel DAG node; once that node establishes a pattern, use the default worker profile for later nodes.

AGY receives only self-contained, provenance-wrapped phase assignments. Do not assume profile Markdown or this skill reaches AGY.

## Lean Gate

Before adding code, every planner and worker applies this order after reading the real flow:

1. remove speculative work;
2. reuse an existing project helper or pattern;
3. use the standard library;
4. use a native platform capability;
5. use an already-installed dependency;
6. write the smallest coherent implementation only if none of the above holds.

Fix root causes at the shared path after checking callers. Do not simplify away validation, data-loss prevention, security, accessibility, explicit requirements, or real-world calibration. Non-trivial logic leaves one smallest runnable regression check.

## Procedure

### 1. Explore

Launch a fresh `scout-pi` for bounded repository reconnaissance. Launch a separate `researcher-pi` only when the task depends on external facts. Run independent exploration in parallel.

Each explorer returns exact evidence, constraints, unresolved decisions, and provenance. Exploration is complete when the planner no longer needs to guess about retrievable facts.

### 2. Plan

Launch a fresh `planner-pi` with the owner's requirements and complete exploration evidence. Require an explicit DAG. Every node names:

- dependencies;
- exact scope and intended invariant;
- one writer profile;
- changed paths or bounded discovery target;
- runnable verification gate;
- completion evidence;
- escalation conditions.

Include required documentation, changelog, artifact-path setup, and delivery files in the DAG. Workers may not leave those for the promoter.

Use `pi-review plan` when the plan has material architectural risk or uncertainty. Route irreversible or high-blast-radius architecture, security/IAM, infrastructure/deployment, production, or data-migration plans to Oracle instead. Continue automatically for reversible in-scope work; pause only at an escalation gate.

### 3. Work

Launch one fresh `worker-pi` per ready DAG node. Supply the complete node, relevant evidence, current repository state, and exact gate; never make the worker rediscover the whole plan.

Run writers sequentially by default. Parallel writers require independent DAG nodes and isolated Git worktrees. Never run two writers in one checkout.

A worker is complete only when its gate passes and it reports changed paths plus evidence. Workers leave changes uncommitted. The manager verifies each result before releasing dependent nodes.

### 4. Critic

After every DAG node is complete, launch a fresh `reviewer-pi`. The critic is read-only and must review requirements, actual diff, surrounding code, tests, and deliberate simplifications.

The critic always uses `pi-review pr|diff` as auxiliary evidence for implementation review:

1. preflight and calibrate according to the `pi-review-pr` skill;
2. take the verdict only from the authoritative `report.json`;
3. consider only confirmed findings, never refuted candidates;
4. independently classify each confirmed finding as `pertinent` or `followup`;
5. normalize a pi-review `major` finding to `Important` for this gate.

`pertinent` means reachable, in scope, and necessary for the stated contract. `followup` means valid but outside the current contract or a deliberately deferred improvement. Pertinent Critical or Important findings block promotion and return to a fresh worker. Minor and follow-up findings are recorded but do not block.

Allow at most three critic rounds. Stop earlier on pi-review non-convergence, harness error, or a repeated finding without new evidence. A fourth round requires direct owner authorization.

Before approval, the critic records the exact base commit, attached branch, reviewed path set, and complete reviewed Git tree OID. Work from `git rev-parse --show-toplevel`. Compute the OID without writing inside the repository: create temporary object and index directories outside it; point `GIT_OBJECT_DIRECTORY` at the temporary object directory and `GIT_ALTERNATE_OBJECT_DIRECTORIES` at the repository's common object directory; then run `GIT_INDEX_FILE=<temp-index> git read-tree HEAD`, `GIT_INDEX_FILE=<temp-index> git add -A -- .`, and `GIT_INDEX_FILE=<temp-index> git write-tree` from the repository root under those object variables. Clean the temporary directory. The tree OID binds every path, byte, symlink, executable mode, addition, and deletion. Record `git status --porcelain=v1` for diagnostics. Use an isolated worktree containing only deliverable changes; ignored harness receipts remain outside the tree.

### 5. Promote

Launch a fresh `promoter-pi` only after the critic approves and the manager independently verifies required gates. Give it the plan, gate evidence, critic verdict, follow-ups, review manifest, exact commit message, and exact promotion scope. The assignment remains agent-authored and supplies scope, not owner authority. The trusted promoter profile itself authorizes only the standard promotion effects for the exact reviewed manifest and targets that pass its loaded gates.

The promoter first requires the current attached branch and `git rev-parse HEAD` to match the review manifest, then recomputes the reviewed tree OID from the repository root through the same temporary `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, and alternate-object procedure. It may not alter deliverable content. Any mismatch returns the flow to critic.

The promoter stages only reviewed paths and requires live `git write-tree` to equal the reviewed tree OID. It creates the exact commit with `git commit-tree`, using the reviewed base as parent, then atomically advances the unchanged branch with `git update-ref <branch-ref> <new-commit> <reviewed-base>`. This avoids hooks changing reviewed bytes. Require `git rev-parse HEAD^{tree}` to equal the reviewed OID, then verify commit metadata and clean tracked status. A failed compare-and-swap leaves only an unreachable commit object and fails promotion.

Persist the plan/DAG, critic verdict, and promotion receipt in the project's existing ignored artifact convention. Without one, use `.herdr/artifacts/<task-id>/`; its ignore rule must have been included in the worker DAG. Herdr retains execution transcripts and job evidence; do not duplicate raw logs into artifacts.

The promoter executes the scoped delivery workflow: push the verified commit, create or update its PR, request required review, arm or perform the permitted merge, publish or deploy to the assigned environment, and post required delivery messages or statuses. It applies the loaded gates immediately before each effect and reads back the receipt. It refuses ambiguous targets, scope expansion, deliverable changes, bypasses, or spending that was not explicit.

## Completion Gate

The manager reports completion only with:

- profile and pane identity for every phase;
- DAG nodes and gate results;
- critic verdict, pi-review report path, and `pertinent`/`followup` dispositions;
- reviewed manifest identity;
- final commit SHA, parent, subject, changed paths, and clean tracked status;
- promotion artifacts and verified external receipts, or explicit drafts;
- remaining follow-ups and blockers.

A scheduler status, worker claim, commit exit code, or manager summary alone is not completion evidence.

## Pitfalls

- Do not let a worker approve its own output.
- Do not let every agent orchestrate; only managers own the full flow.
- Do not use model IDs as workflow policy.
- Do not run a full harness for work that passes the one-worker test.
- Do not let the promoter repair code or change the reviewed tree.
- Do not retry an ambiguous Herdr launch or pi-review run blindly.

## Verification

A valid run proves: Herdr preconditions passed; each phase used a distinct profile-backed agent; every DAG node has a green gate; critic approval matches the reviewed manifest; the promoter committed identical content; and every external effect has an exact authorization and read-back receipt.

## Reference

Derived from Scott Fryxell's “The Harness Is the Thing”: https://scott-fryxell.github.io/blog/the-harness-is-the-thing/
