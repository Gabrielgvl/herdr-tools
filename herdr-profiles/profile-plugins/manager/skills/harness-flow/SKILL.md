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
2. Daemon operations — launch, run, status — go only through `herdr_launch`, `herdr_run`, and `herdr_status`, reached natively over MCP in Claude and Devin, and through the executor→MCP gateway (`executor_execute`) in Pi. They are the only daemon path; there is no CLI equivalent, so if the MCP surface or daemon is unavailable or incompatible, stop and report the blocker. The raw `herdr` CLI is welcome for pane-level work per the manager skill, including its re-read-before-write rule: never write into a `blocked`, unknown, or unproven pane. Never direct tmux control or hidden subagents.
3. Read `herdr_status` for the caller's runs, intents, and mailbox before launch. An invalid catalog or an unavailable daemon is a blocker.
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

Launch a fresh `scout`-labeled Task for bounded repository reconnaissance. Launch a separate `research`-labeled Task only when the task depends on external facts. Launch every independent explorer in the same turn.

Each explorer returns exact evidence, constraints, unresolved decisions, and provenance. Exploration is complete when the planner no longer needs to guess about retrievable facts.

### 2. Plan

Launch a fresh `plan`-labeled Task with the owner's requirements and complete exploration evidence. Require an explicit DAG. Every node names:

- dependencies;
- exact scope and intended invariant;
- one writer Task;
- changed paths or bounded discovery target;
- write footprint: the files, and the regions within shared files, that the node edits;
- runnable verification gate;
- completion evidence;
- escalation conditions.

Plan for maximum parallel width. Add a dependency edge only for a real data dependency or an overlapping write region, and state which one each edge is. Split nodes so that writers touch disjoint files, or disjoint regions of a shared file that a 3-way merge can reconcile. Group the nodes into parallel waves and name the critical path. Express large mechanical changes (renames, moves, import rewrites, bulk formatting) as re-runnable scripts, so they can be regenerated on the final base instead of rebased by hand. An unexplained sequential order is a planning defect.

Overlap phases across a multi-step plan. While one step is in work, explore and plan the next independent step, and start its writers as soon as its footprint no longer overlaps in-flight work.

Separate facts from hypotheses. Every causal or quantitative claim in the plan is either measured, citing the command and its result, or labeled a hypothesis. A hypothesis can't justify a work node; add a measurement node first. The same rule applies to any plan document the manager writes for the owner.

Check the release path before work starts. State how production would be hotfixed while the flow is in progress: which branch a hotfix deploys from, and which merged flow work would ride along with it. If an emergency deploy would carry unproven flow changes, get the owner's merge-timing decision before any merge.

Persist the DAG with hflow for parallel or multi-flow runs. Write each flow's `plan.json` through `hflow apply` (see the `hflow` skill), stamp `pane_id` from each launch, update node states as results are verified, and serve the dashboard to the owner. A markdown DAG is enough only for a single, sequential flow.

Include required documentation, changelog, artifact-path setup, and delivery files in the DAG. Work Tasks may not leave those for promotion.

Use `pi-review plan` when the plan has material architectural risk or uncertainty. For irreversible or high-blast-radius plans (architecture, security/IAM, infrastructure/deployment, production, data migration), use Oracle only when the owner has requested Oracle for the current task, as the manager skill's review routing requires; otherwise use `pi-review plan` and flag the risk to the owner. Continue automatically for reversible in-scope work; pause only at an escalation gate.

### 3. Work

Launch one fresh `work`-labeled Task per ready DAG node. Supply the complete node, relevant evidence, current repository state, and exact gate. Never make the worker rediscover the whole plan.

Run in parallel by default. A node is ready when its dependencies are done and its write footprint does not overlap an in-flight node's. Launch every ready node in the same turn, each writer in its own Git worktree; never run two writers in one checkout. Tell each writer which regions its siblings own, and forbid reformatting or reordering outside its own footprint. Run nodes sequentially only for a real dependency or an overlapping footprint.

Batch tiny nodes. When several ready nodes are each tiny (a few lines, one gate) and have disjoint footprints, one writer may take them together as a wave in one worktree. The report must keep each node's own gate result and evidence. Never batch nodes with overlapping footprints or different risk classes, such as a test-only change together with a production-path change.

Bound the width by shared resources, not by habit. Expensive gates, such as DB-backed suites or container builds, contend on one host, so lanes may run targeted gates while the integrated tree always runs the full gate. State the bound you chose.

Seeding lanes. When a lane needs uncommitted results from finished nodes, seed it from a scratch commit object without moving any branch:

1. In the integration worktree, build a temporary index: `GIT_INDEX_FILE=<tmp> git read-tree HEAD`, then `GIT_INDEX_FILE=<tmp> git add -A -- . ':!<in-flight paths>'`.
2. `git write-tree`, then `git commit-tree <tree> -p HEAD`.
3. `git worktree add -b <lane-branch> <path> <seed>`.

The seed and the lane branches are scratch and are never promoted.

Integrating lanes. As each lane's nodes pass their gates, the manager merges that lane into the integration worktree one lane at a time, with a per-file 3-way merge against the seed. For each path in `git -C <lane> diff --name-only <seed>`, run `git merge-file <integration>/<path> <seed version of path> <lane>/<path>`; that seed version comes from `git show <seed>:<path>`. `git diff` does not list new untracked files, so copy each path from `git -C <lane> ls-files --others --exclude-standard` as well, and handle lane deletions (`git -C <lane> diff --name-only --diff-filter=D <seed>`) explicitly. Loop over the paths line by line (`while IFS= read -r`), because zsh does not word-split `$var`. Do not use `git apply --3way`: it goes through the index and refuses a dirty integration worktree (`does not match index`). A conflict goes to a fresh `work` Task, and the manager never hand-resolves one. Once all lanes are integrated, a fresh worker runs the full gate on the integrated tree before the critic. Delete the lane worktrees and branches after promotion.

A worker is complete only when its gate passes and it reports changed paths plus evidence. Workers leave changes uncommitted. The manager verifies each result as soon as it arrives and immediately releases the nodes that become ready.

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
- Do not serialize nodes whose footprints are disjoint, and do not let a finished result wait unverified while ready nodes sit idle.
- Do not let promotion repair code or change the reviewed tree.
- Do not retry an ambiguous Herdr launch or pi-review run blindly.

## Verification

A valid run proves: Herdr preconditions passed; each delegated phase used a distinct supervised child; every DAG node has a green gate; critic approval matches the reviewed manifest; the manager committed identical content; and every external effect has an exact authorization and read-back receipt.

## Reference

Derived from Scott Fryxell's “The Harness Is the Thing”: https://scott-fryxell.github.io/blog/the-harness-is-the-thing/
