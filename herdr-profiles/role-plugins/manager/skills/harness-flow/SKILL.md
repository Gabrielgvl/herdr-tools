---
name: harness-flow
description: Use when complex work needs phased Herdr agents.
---

# Harness Flow

Run complex engineering work as a visible, Task-defined Herdr flow:

`explore → plan → work → critic → manager promotion`

The manager coordinates. Each delegated phase runs as a separate supervised child. Runner and model selection belong to the runtime's deterministic operating-point routing, not this skill.

## When to Use

Activate when the task cannot be completed safely and fully by one bounded worker with one objective gate. Typical signals are material ambiguity, multiple DAG nodes or components, independent review needs, or an escalation risk.

Activate when the owner asks for the harness explicitly. Skip when the owner explicitly requests the direct path and no safety boundary requires the full flow.

Do not use for a localized change that one bounded worker can implement and verify end to end.

## Preconditions

1. Require `HERDR_ENV=1`. Outside Herdr, stop and request a new manager session. Never fall back to inline orchestration.
2. Prefer `herdr_inspect`, `herdr_launch`, `herdr_communicate`, `herdr_wait`, and `herdr_jobs`. If they are unavailable or incompatible, stop unless the owner explicitly authorizes raw CLI fallback for the current task. An authorized fallback must preserve stable targets, inspection, supervision, and bounded waits, then return to typed tools once healthy. Never fall back to direct tmux control or hidden subagents.
3. Inspect the current context and operating-point catalog before launch. An invalid catalog is a blocker.
4. Keep the manager on its isolated tab and use the manager skill for topology, provenance, supervision, waits, ownership, and cleanup.

## Task Routing

Launch one flat caller-authored Task per `herdr_launch` call, labeled by phase such as `scout`, `research`, `plan`, `work`, and `critic`. Each Task carries `objective`, `scope`, `doneWhen`, and optional `constraints` — the single work contract that routing, supervision, and evidence all share. Omit `tier` by default: the runtime judges the weakest sufficient tier from the Task text, not from the phase label, so state the phase's real difficulty in `objective` and `scope` rather than pointing at a task file. An explicit `tier` raises that start by at most one tier and never lowers it.

Never name a runner, model, account, or deleted profile. The runtime derives the workload profile, selects a reviewed operating point deterministically, and owns fallback, identity, topology, delivery, and supervision. AGY and Devin receive only self-contained, provenance-wrapped Task prompts. Do not assume this skill reaches the child.

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

Launch a fresh `scout`-labeled Task for bounded repository reconnaissance. Launch a separate `research`-labeled Task only when the task depends on external facts. Run independent exploration in parallel.

Each explorer returns exact evidence, constraints, unresolved decisions, and provenance. Exploration is complete when the planner no longer needs to guess about retrievable facts.

### 2. Plan

Launch a fresh `plan`-labeled Task with the owner's requirements and complete exploration evidence. Require an explicit DAG. Every node names:

- dependencies;
- exact scope and intended invariant;
- one writer Task;
- changed paths or bounded discovery target;
- runnable verification gate;
- completion evidence;
- escalation conditions.

Include required documentation, changelog, artifact-path setup, and delivery files in the DAG. Work Tasks may not leave those for promotion.

Use `pi-review plan` when the plan has material architectural risk or uncertainty. Route irreversible or high-blast-radius architecture, security/IAM, infrastructure/deployment, production, or data-migration plans to Oracle instead. Continue automatically for reversible in-scope work; pause only at an escalation gate.

### 3. Work

Launch one fresh `work`-labeled Task per ready DAG node. Supply the complete node, relevant evidence, current repository state, and exact gate. Never make the worker rediscover the whole plan.

Run writers sequentially by default. Parallel writers require independent DAG nodes and isolated Git worktrees. Never run two writers in one checkout.

A worker is complete only when its gate passes and it reports changed paths plus evidence. Workers leave changes uncommitted. The manager verifies each result before releasing dependent nodes.

### 4. Critic

After every DAG node is complete, launch a fresh `critic`-labeled Task whose `constraints` require read-only review. The critic must review requirements, actual diff, surrounding code, tests, and deliberate simplifications.

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

Do not launch a promoter child. The universal baseline requires every child to leave deliverable changes uncommitted for its handoff owner. After critic approval, the manager is that handoff owner and performs the scoped delivery workflow.

First require the current attached branch and `git rev-parse HEAD` to match the review manifest. Recompute the reviewed tree OID from the repository root through the same temporary `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, and alternate-object procedure. Do not alter deliverable content. Any mismatch returns the flow to critic.

Stage only reviewed paths and require live `git write-tree` to equal the reviewed tree OID. Create the exact commit with `git commit-tree`, using the reviewed base as parent, then atomically advance the unchanged branch with `git update-ref <branch-ref> <new-commit> <reviewed-base>`. Require `git rev-parse HEAD^{tree}` to equal the reviewed OID, then verify commit metadata and clean tracked status. A failed compare-and-swap leaves only an unreachable commit object and fails promotion.

Persist the plan/DAG, critic verdict, and promotion receipt in the project's existing ignored artifact convention. Without one, use `.herdr/artifacts/<task-id>/`; its ignore rule must have been included in the worker DAG. Herdr retains execution transcripts and job evidence. Do not duplicate raw logs into artifacts. When the plan artifact is managed with **hflow** (see the `hflow` skill), persist and update it through `hflow apply` instead of hand-editing `plan.json`, and serve the live dashboard for the owner; herdr live badges remain observations, never completion evidence.

The manager then pushes the verified commit, creates or updates its PR, requests required review, arms or performs the permitted merge, publishes or deploys to the assigned environment, and posts required delivery messages or statuses. Apply the loaded gates immediately before each effect and read back the receipt. Refuse ambiguous targets, scope expansion, deliverable changes, bypasses, or spending that was not explicit.

## Completion Gate

The manager reports completion only with:

- selected operating point and supervisor job identity for every delegated phase;
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
- Do not use runner or model IDs as workflow policy.
- Do not run a full harness for work that passes the one-worker test.
- Do not let promotion repair code or change the reviewed tree.
- Do not retry an ambiguous Herdr launch or pi-review run blindly.

## Verification

A valid run proves: Herdr preconditions passed; each delegated phase used a distinct supervised child; every DAG node has a green gate; critic approval matches the reviewed manifest; the manager committed identical content; and every external effect has an exact authorization and read-back receipt.

## Reference

Derived from Scott Fryxell's “The Harness Is the Thing”: https://scott-fryxell.github.io/blog/the-harness-is-the-thing/
