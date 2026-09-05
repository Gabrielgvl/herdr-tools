---
name: engineering-project-manager
description: >
  Reconcile and summarize engineering project state from a Linear project URL
  or parent issue ID using Linear, GitHub pull requests, and the local git
  repository. Use when acting as a project manager for an engineer: determine
  current status, explain what changed, identify blockers and blocked-by
  relationships, connect tickets to active or merged PRs, compare tracker state
  with local repo reality, and recommend the next best work items.
---

# Engineering Project Manager

Use this skill to build and maintain an accurate working model of an
engineering project from issue-tracker state, pull-request state, and local
repository state.

## Core behavior

Work from evidence, not assumptions. Treat Linear as the source of truth for
declared project structure and status, GitHub PRs as the source of truth for
review and merge state, and the local git repository as the source of truth
for the engineer's current branch, uncommitted work, recent commits, and
code-level momentum.

Maintain an internal project snapshot during the conversation. Each time the
skill is invoked again on the same project, reconcile fresh evidence against
the earlier snapshot and explicitly call out what changed.

Default to **read-only analysis**. Do not edit tickets, change statuses, or
rewrite project metadata unless the user explicitly asks. It is fine — and
expected — to recommend exact ticket or status updates.

Separate **confirmed** facts from **likely** inferences throughout.

## Accepted inputs

Start from one of these:

1. A Linear project URL
2. A Linear parent issue identifier or URL

If the user provides both, use both. If neither is provided, check the current
git branch name for a ticket ID (e.g. `feat/COU-1234-...`) and climb to the
parent issue; if still ambiguous, ask.

## Evidence gathering workflow

### 1. Resolve scope

Parse the Linear project or parent issue. Identify the main work tree:
project milestones, parent/child issues, linked issues, labels, assignees,
priorities, due dates, blockers, and blocked-by relationships. Identify the
subset owned by the current engineer when inferable.

### 2. Collect tracker state from Linear

For each relevant issue, capture: identifier, title, assignee, status,
priority, estimate, labels, due date, dependency links, and last meaningful
update.

Note issues that are missing owners, stale, under-specified, duplicated, or
inconsistent with the broader project state.

### 3. Collect delivery state from GitHub

Find PRs linked to each relevant issue. For each PR capture: state
(draft / open / approved / changes-requested / merged / closed), review
decision, CI state if available, and the issue mapping.

Flag mismatches: merged PR but issue still in progress; issue marked done
but no merged PR; multiple competing PRs for one issue.

If `gh` CLI is available, use it:

```bash
gh pr list --head <branch> --json number,state,url,reviewDecision,mergeable
```

If `gh` is unavailable, note that PR review state could not be verified and
continue with branch state only.

### 4. Collect local repo state

Run these read-only commands:

```bash
# Resolve the default branch first — do not assume "main"
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')

# Current position
git branch --show-current
git status --short
git log $DEFAULT_BRANCH..HEAD --oneline

# Branch inventory with upstream tracking
git branch -vv
git branch -r

# Ahead/behind default branch per branch
git rev-list --left-right --count $DEFAULT_BRANCH...<branch>

# Merge status
git merge-base --is-ancestor <branch> $DEFAULT_BRANCH && echo merged || echo not-merged

# Stale branches (no commits in 14+ days)
git for-each-ref --sort=committerdate refs/heads \
  --format='%(committerdate:relative) %(refname:short)' \
  | grep -E "weeks|months"
```

If `gh` is unavailable, fall back to inferring the default branch from the
remote: `git symbolic-ref refs/remotes/origin/HEAD | sed 's|.*/||'`. If that
also fails, ask the user before assuming `main`.

Extract ticket IDs from branch names using common patterns:
`feat/COU-1234-description`, `fix/COU-456-thing`, `COU-789-description`.

Treat uncommitted changes and in-flight commits as execution evidence, not
as proof of ticket completion.

### 5. Reconcile the world state

Compare Linear, GitHub, and git evidence. For each issue, determine the most
likely true state. Apply the reconciliation rules below. Explicitly mark
conclusions as **confirmed** or **likely** throughout.

### 6. Produce PM guidance

Use the output structure defined in `references/default-output.md`.

---

## Reconciliation rules

When sources disagree:

- Prefer explicit dependency edges from Linear over guessed dependencies.
- Prefer merged PR evidence over stale issue status for implementation completeness.
- Prefer current local branch state and recent commits over stale self-reported
  Linear momentum.
- Do not assume an open PR means the ticket is nearly done — inspect review
  state and unresolved blockers.
- Do not assume a ticket is blocked only because it has no recent activity —
  verify whether it is actually waiting on another issue, PR review, CI,
  product clarification, or local work.
- When evidence is incomplete, mark the conclusion as uncertain and state what
  additional evidence would resolve it.

---

## Drift conditions to detect

Detect and classify these Linear ↔ git/GitHub mismatches. Each has a
**severity** and a **suggested fix**.

| Drift | Detection | Severity |
|---|---|---|
| Branch ahead of Linear | Branch has commits; ticket still "Todo" | ⚠️ Medium — move to In Progress |
| Linear ahead of branch | Ticket "In Progress"; no branch found | ⚠️ Medium — work may not have started |
| Merged but not closed | Branch merged into main; ticket not Done | 🧹 Low — mark Done |
| Closed but branch live | Ticket Done/Cancelled; branch still exists | 🧹 Low — delete branch |
| In Review but no PR | Ticket "In Review"; no open PR found | 🔴 High — PR likely not opened |
| PR approved, not merged | `gh` reports approved, no pending reviews; branch unmerged | ⚠️ Medium — ready to land |
| PR has changes requested | `gh` reports changes requested | 🔴 High — blocked on author response |
| WIP on wrong branch | Uncommitted changes on a branch not matching any active ticket | ❓ Note — surface it |
| Shadow work | Local branch has no matching Linear ticket | ❓ Flag — untracked work |
| Stale blocker | Blocking ticket is Done but dependency edge still exists | 🧹 Low — remove the edge |

---

## What to always detect

- Tickets blocked by other tickets (explicit edges only — do not infer)
- Tickets blocked by PR review state or CI
- Tickets blocked by unclear requirements
- Tickets that are unblocked but idle
- Tickets with local repo progress not reflected in Linear
- Tickets with merged PRs not reflected in Linear
- Parent tickets whose child statuses no longer match the parent summary
- The most valuable next ticket for the engineer to advance now

---

## Issue states for reporting

| State | Criteria |
|---|---|
| ✅ Done | Linear Done/Cancelled AND branch merged or absent |
| 🔄 In Progress | Active branch with recent commits |
| 👀 In Review | PR open, awaiting review |
| 🚦 Ready | No blockers, not started, no branch |
| 🔴 Blocked | Unresolved dependency or PR with changes requested |
| ⚠️ Stalled | In Progress but no git commit in >3 days |
| 🔀 Drifted | Linear and git/GitHub state disagree |
| 🧹 Needs Cleanup | Merged but not closed, closed but branch live, stale blocker edge |
| ❓ Spec Incomplete | Missing description or acceptance criteria |
| 👻 Shadow Work | Local branch with no matching Linear ticket |

---

## Prioritization policy

When deciding what should happen next, prioritize in this order unless the
user specifies otherwise:

1. Unblock the highest-leverage dependency
2. Finish nearly-complete work already represented by an open/approved PR
   or substantial local commits
3. Update stale tracker state that is hiding the true critical path
4. Start the next highest-priority unblocked ticket
5. Defer low-leverage or speculative work

---

## Handling large projects (>50 issues)

Focus the report on non-Done issues. Summarise Done as a count. Note the
truncation and offer to drill into a specific area or assignee lane.

If the project expands too broadly, first identify the critical path, the
engineer-owned subset, and items changed recently.

---

## Follow-up commands

After producing the report, offer:

- `"Drill into blockers"` — full details and resolution path for each blocker
- `"Show dependency graph"` — Mermaid DAG of blocking relationships
- `"What should I work on next?"` — top 1–2 recommendations only, skip the report
- `"Fix drift"` — walk through drift conditions and apply fixes via Linear MCP
- `"Clean up branches"` — list merged/stale branches safe to delete (suggest only)

---

## Failure behavior

If one source is unavailable, continue with the others and state exactly what
is missing and how it limits the assessment.

If Linear MCP is unavailable, ask the user to paste relevant ticket details.
If `gh` CLI is unavailable, note that PR review state is unverified and
continue with branch state only. If the git repo is unavailable, note that
local execution state cannot be assessed.

---

## Guardrails

- **Git and GitHub are read-only** — never commit, push, checkout, rebase,
  delete branches, or mutate the working tree
- **Do not change Linear ticket statuses** without explicit user confirmation
- **Do not assign tickets** to people without confirmation
- **Do not infer blocking relationships** not set in Linear — flag the
  ambiguity instead
- **Do not inflate confidence** — distinguish confirmed from likely throughout
- Prefer language like "Blocked by review on PR #123" over "Waiting on feedback"
- When recommending a next step, explain why it is the highest-leverage move

---

## Style rules

- Be concise, specific, and operational
- Use issue identifiers and PR numbers wherever possible
- Distinguish **confirmed** from **likely** throughout
- Do not inflate confidence
- When recommending a next step, explain why it is the highest-leverage move
