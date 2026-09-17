---
name: delivery-assurance
description: "Enforces the Linear proof boundary for planning, implementation, review, readiness, and merge. Use for multi-surface work, ownership or plan changes, exact-head evidence, Scope Review, or moving a ticket to Done."
compatibility: "Requires the repository's configured Linear/GitHub integrations; no separate workflow runtime is required."
---

# Native delivery assurance

Use this skill during planning, implementation, review/readiness, merge preparation, and closure
when a delivery has multiple surfaces, its plan changes, or completion is being claimed. It is the
cross-cutting proof protocol over native Linear, GitHub, and repository systems—not a workflow engine.
It creates no registry, ledger, token, compatibility layer; no raw JSON or transcript-only exception.
Follow invoking agents' output contracts; this skill supplies the gates below.

## Owner boundaries

Keep adjacent mechanics in their owning skills rather than copying them here:

- `linear-mcp` — Linear operations, document/comment/relation readback, status, and assignment.
- `git-flow` — Git provenance, branches, commits, and parallel worktree isolation.
- `dev-evidence-gate` — deployment/smoke applicability and method.
- `courier-pr-gates` and `release-pr-validation` — review, approval, merge, and release policy.

This skill joins those results at the ownership, evidence, and closure boundaries; it does not add a second policy or require approvals beyond the repository's existing policy.

## 1. Native ownership, exclusions, and open questions

Parent acceptance criteria are claims. Map each claim to concrete implementation and proof surfaces.
Every included surface has exactly one native owner: a child issue, or a valid atomic standalone leaf
that self-owns its surface. A parent with children is orchestration-only and cannot own a direct
implementation PR. Do not invent a child for a genuinely atomic leaf.

Give every surface exactly one disposition:

- `CHILD_TICKET` — a native child owns the implementation or proof.
- `BLOCKER` — a missing prerequisite, contradiction, or missing proof stops that surface.
- `OPEN_QUESTION` — use the native `open-question` convention; name the decision owner and
  downstream effect.
- `EXCLUSION` — the surface was inspected and is explicitly outside the claim, with source and
  reason recorded.

One parent claim may span one or more owned child surfaces, while each surface has one owner. Parent
prose, a plan, chat transcript, sibling PR, or Done state never establishes ownership. A parent-only
or transcript-only implementation claim without a native owning delivery issue, linked PR, and exact-head
evidence is not success; block it. Native `blocks`/`blocked-by` data is the dependency source; use
`linear-mcp` for its authoritative readback.
Unknown is not success. There are no hidden transcript-only gaps.

## 2. Scope Review lifecycle

Maintain one attached, human-readable Linear Document titled exactly `Scope Review — <ticket>`.
It records the claims and observable results, sources inspected, every surface's owner/disposition,
current native dependencies, mapper/challenger reconciliation, assumptions/open questions, current
decision, and dated change history. It is not a machine artifact or substitute for native graph state.

At planning:

1. The primary mapper reads the current issue/acceptance criteria, native graph, source, ADRs, and
   relevant evidence, then records every concrete surface and disposition.
2. A fresh read-only `scope-challenger` independently tests the claims, ownership, exclusions,
   dependencies, and evidence for omissions or contradictions.
3. The authorized mapper persists agreements, disagreements, and every omission disposition in the
   existing Scope Review, then reads back the document and affected native graph before implementation.
4. Before writing or revising the plan, recompute surface ownership and projected changed-source LOC.

After implementation or a review fix, run a fresh delta challenger against the exact diff and
reconcile it into the same document before evidence or review resumes. Before review, readiness,
merge, or closure, live-read the current document and graph; a cached or transcript-only read is not
proof. For a one-surface standalone leaf, record its self-ownership and an explicit complete-scope
reconciliation rather than manufacturing a child.

Keep one closure matrix for all review findings. After the first full review, review only the delta
and unresolved findings unless the architecture changes again.

## 3. Exact-revision evidence publication and invalidation

Before review/readiness/auto-merge/merge, each affected implementation child (or standalone leaf)
must have one concise native evidence comment, published/read back through `linear-mcp`, bound to the
exact PR head and owned changed surface. Publish a new comment for each qualified head; never edit
historical evidence. It points to positive checks/evidence, current readbacks, and any blocker or
applicability disposition; owner skills define how tests, CI, deployment/smoke, cleanup, and review
evidence are produced.

Bind the authoritative PR head and changed-file scope before publication. Re-read the live head
immediately before publishing and immediately before a gate; a same-head cache is not a read. Evidence
proves only the exact revision it names. Any affected code or infrastructure revision invalidates
prior exact-head tests, CI, deployment/smoke, cleanup, review, readiness, and merge evidence. Run a
fresh delta challenge and requalify from the new head. Preserve evidence only when requirement,
surface, dependency, infrastructure, and proof scope are all unchanged and the verifier records why.
Applicability or exemption comes from `dev-evidence-gate`; task type alone never proves exemption.

## 4. Plan-change graph reconciliation

A changed acceptance criterion, requirement, owner, dependency, contract, IAM binding, migration
strategy, or affected code/infra surface is a graph change, not a chat note:

An owner-approved scope expansion immediately invalidates prior review, CI, deploy, and smoke evidence,
even before code changes.

1. Pause affected unmerged PRs and writes only; never rewrite terminal child history.
2. Follow native relations to identify the native blocker subgraph. If blast radius is unknown,
   challenge the whole relevant scope and invalidate the broader proof.
3. Update the affected parent criteria, child issues, native open questions, and relation edges
   through their owning Linear procedure; read back every change.
4. Run a delta `scope-challenger` with the old/new claim, changed surfaces, and current graph.
5. Update Scope Review ownership, reconciliation, decision, and dated change history; read it back.
6. Invalidate affected exact-head proof and requalify it from the new revision; preserve unaffected evidence only when proven.
7. If merged work needs more implementation, report/create a natively linked remediation child via
   the authorized owner. Do not reopen or edit terminal history to conceal the change.

## 5. Integrated pre-merge and parent-closure boundaries

### Before review/readiness/auto-merge/merge

The owner skills supply their normal review, approval, merge, release, Git, and evidence mechanics;
these gates apply before review/auto-merge/merge and readiness. Delivery assurance additionally
requires that every claim surface is owned or evidenced as an exclusion, the Scope Review and native
graph are fresh, exact-head evidence matches the live PR, and no plan/base/source drift or unresolved
blocker/open question invalidates it. If any predicate is unknown, stop; do not manually move a child
to Done to make the graph look complete.

### After merge

Automatic child Done after a PR merge is an event to reconcile, not proof; child Done alone never
closes a parent. The pre-merge gate must already have passed. Post-merge reconciliation is read-only:
inspect the merged PR/commit, child state, native graph, Scope Review, and preserved exact-head
evidence. The verifier does not add late proof, mutate status/document state, or create a remediation child; it reports any required remediation child to the authorized owner.

### Parent closure

Every canonical completion route—parent, planned sub-ticket, or atomic standalone leaf—runs a fresh read-only `closure-verifier`; route selection cannot bypass it. Parent closure requires a fresh live reconciliation. A planned child also reads its parent
Scope Review but never substitutes for separate parent closure. Closure requires all planned children
complete, all claims proven or explicitly excluded with evidence, unique surface ownership, reconciled
native relations, a current Scope Review, terminal PR state, and no unresolved blocker, open question,
or unknown exact-head proof. The verifier returns its existing concrete result contract: `PASS`, `PASS WITH NOTES`, or
`BLOCKED`; it never performs the status mutation.

## 6. Fail-closed anti-bypass behavior

Missing, stale, contradictory, ambiguous, or unowned ownership, exclusion, relation, Scope Review,
source, exact-head, or evidence readback is `BLOCKED`. A tool, API, or authentication failure is
`UNKNOWN`, not success; stop before mutation where possible and do not retry an operation whose effect
is unknown. Parent prose, a transcript, boolean-only PASS, merged PR, automatic Done event, cached
read, or task-type exemption cannot bypass a gate.

Never repair a failure with a fallback registry, hidden token, raw JSON permit, compatibility artifact,
manual status shortcut, late post-merge proof, or an invented child for an atomic leaf. Invoke the
existing challenger, authorized mapper, closure verifier, and status owner contracts; this skill
itself authorizes no Linear, GitHub, source, deployment, or status mutation.

If any gate is unknown or incomplete, return `BLOCKED` with the exact missing native surface and reconciliation owner. Otherwise report the current Scope Review decision, exact revision, ownership/exclusion result, evidence freshness, plan-change disposition, and closure result; the shortest valid proof is native, current, exact, and independently read back.
