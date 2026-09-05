# Default Output Template

Use this structure by default. Omit sections where no evidence exists.

---

# Project sync — [Project / Parent Issue]
*Synced: [timestamp] · Sources: Linear + GitHub + git (`[branch]`)*

## Executive summary
One short paragraph: where the project actually stands, whether delivery is on
track, what is actively moving, and what is truly constrained. Distinguish
**confirmed** from **likely**.

---

## Current status

### ✅ Done
Issues or deliverables that are truly complete, with merged PR evidence where
available.

### 🔄 In Progress / 👀 In Review
Issues with active implementation, open PRs, or clear local repo activity.
For In Review, include PR link and review state.

### 🔴 Blocked
- ISSUE-KEY — exact blocker (ticket / PR / CI / spec gap)

### ⚠️ Stalled / 🔀 Drifted
- ISSUE-KEY — stalled N days without commit; last branch activity: [date]
- ISSUE-KEY — drift type: [branch ahead of Linear | merged but not closed | etc.]
  → Suggested fix: [specific action]

### 👻 Shadow Work
Branches with no matching Linear ticket:
- `branch-name` — last commit [N days ago]; disposition needed

### 🚦 Ready to Start
Issues that could be picked up immediately, ordered by priority then by how
many other tickets they unblock.

---

## Blockers and dependency map
Direct statements only — no vague "waiting on feedback":

- ISSUE-123 is blocked by ISSUE-118: API contract not finalized
- ISSUE-118 is blocking ISSUE-123 and ISSUE-129
- ISSUE-140 is blocked by PR #455 review (changes requested)
- ISSUE-151: no active dependency found — **likely** unblocked

---

## What changed since last sync
*(Include only when there is an earlier snapshot in the conversation.)*

- ISSUE-123 moved from in progress to effectively blocked after PR #455
  received changes requested
- PR #462 merged — ISSUE-131 is **likely** ready to mark Done
- Local branch now references ISSUE-142 with uncommitted work, suggesting
  active implementation

---

## Recommended next actions
Ranked by leverage. Explain why each is the highest-leverage move.

1. **[Action]** — [why this unlocks the most downstream work]
2. **[Action]** — [why this comes second]
3. **[Action]** — [what can wait and why]

---

## Suggested tracker cleanups
Specific, actionable — not vague:

- Mark ISSUE-131 Done — PR #462 confirmed merged
- Add blocked-by edge: ISSUE-123 → ISSUE-118
- Remove stale blocker edge: ISSUE-99 → ISSUE-123 (ISSUE-99 is Done)
- Reassign ISSUE-150 or mark unowned — no assignee, High priority
- Move ISSUE-456 to In Progress — branch `feat/COU-456-...` has 5 commits

---

## Open questions / uncertainty
- Missing evidence that would materially change the assessment
- Cases where local repo suggests progress but no linked issue or PR exists
- Assumptions made due to unavailable sources (Linear MCP down, `gh` unavailable, etc.)
