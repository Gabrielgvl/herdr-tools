---
name: ticket-writer
description: "Break down a task into one well-defined ticket for one engineer (Linear, Jira, GitHub Issues). Use for \"make a ticket for X\", \"write this up\", filing an issue, or a vague idea. Read any parent issue and file as a child."
compatibility: "Works with any issue tracker MCP (Linear, Jira, GitHub Issues). Falls back to Markdown output if no tracker is connected."
---

# Ticket Writer

Produce a single, well-scoped engineering ticket for one engineer to pick up and execute
without ambiguity. The output should be immediately fileable — no hand-waving, no open
questions left for the assignee to resolve.

---

## When NOT to use this skill

Stop and tell the user before attempting a ticket if:

- The request is really a **project plan** — multiple tickets are needed and none is obvious
  as the right starting point
- The work is **too ambiguous to define** even one useful task ("improve the platform")
- The request is for **bug triage** or incident analysis rather than implementation work
- The request is for **product strategy** rather than a concrete engineering change

If the work clearly decomposes into multiple tickets:
- List 2–5 candidate tickets
- Ask the user which one to proceed with, OR
- Select the most foundational slice and proceed (state your choice)

---

## Phase 1 — Gather Context

Work through sources in order. Stop once you have enough.

### 1a. Parent issue (if present)

If a parent issue, epic, or story is referenced:

- Fetch it via the tracker tool
- Extract:
  - project/team
  - labels/components
  - constraints / decisions already made
  - related or existing sub-tasks (avoid duplication)
- Identify the **specific slice** this ticket should cover
- This ticket **must be filed under the parent**

Do not rely on the title alone — read the full content.

---

### 1b. Codebase signals (if applicable)

If the task touches existing code:

Scan for:
- Entry points (handlers, APIs, workers, jobs)
- Ownership boundaries (services/modules)
- Existing patterns (naming, retry logic, logging, testing)
- Relevant files likely to be modified

Capture:
- Language/framework
- Test structure
- Any mismatches between requested work and actual architecture

Avoid:
- Inventing abstractions that don’t exist
- Naming components that don’t match the repo

Prefer referencing **real file paths or modules** when obvious.

---

### 1c. Ask the user (only if needed)

Ask once, grouping all questions (max 5).

Only ask for missing critical information:

| Gap | Example |
|-----|--------|
| Goal | "What outcome does this enable?" |
| Scope | "Is X in or out of scope?" |
| Success | "How will we verify this is done?" |
| Constraints | "Any performance or compatibility constraints?" |
| Ownership | "Which team owns this?" |

**Minimal context gate (for vague inputs):**
1. Goal (outcome)
2. One non-goal
3. How done is verified

Proceed once you have these.

---

## Phase 2 — Scope the Ticket

### Single-engineer rule

Target: **1–5 days of focused work**

Too big if:
- Multiple services or systems
- Requires phased rollout
- Combines feature + migration + observability
- Cannot be reviewed as one change

Right-sized if:
- One subsystem
- One primary deliverable
- 3–6 acceptance criteria
- Clear boundaries and non-goals

---

### Non-goals are mandatory

List at least one explicit non-goal.

If not provided, infer likely adjacent work and exclude it.

---

### Acceptance criteria must be falsifiable

Rules:
- Binary pass/fail
- Observable without asking the author
- Start with a verb

Examples:
- "Endpoint returns 200 with `{ id, createdAt }`"
- "P95 latency < 200 ms at 100 RPS"
- "Logs include `attempt_count`"

Avoid:
- "works correctly"
- "is improved"

**Heuristic:**
- 3–6 criteria ideal
- >7 → ticket likely too large

---

### Failure-mode thinking (when relevant)

For infra / backend / distributed systems:

Consider explicitly:
- Failure handling (timeouts, retries)
- Backoff / rate limiting
- Partial failures
- Load shedding / degraded behavior

Do not over-design — include only if relevant to the task.

---

## Phase 3 — Write the Ticket

---

### Title
`[Component] Imperative action (≤ 72 chars)`

---

### Summary
2–4 sentences:
- What this does
- Why it matters
- Link to larger effort if applicable

---

### Background / Context
Optional. Link to relevant issues/docs.

---

### Goal
Outcome, not implementation.

---

### Non-Goals
Explicit exclusions.

---

### Scope
Boundaries of work:
- Systems touched
- Code areas
- What is NOT touched

---

### Proposed Approach (optional)

Include ONLY if:
- There is a non-obvious design decision
- OR the parent issue implies direction

Keep high-level. No full design.

---

### Acceptance Criteria

Numbered, falsifiable, 3–6 items preferred.

---

### Out-of-Scope Edge Cases (optional)

List known edge cases that should NOT be handled here.

---

### Dependencies / Blockers

Set the relationship **direction** deliberately — do not default to `related`:

- **`blocks`** — this ticket must land before the target can proceed. Use it whenever the
  new ticket *gates* later work (e.g. a follow-up that fixes a correctness gap the cutover
  depends on `blocks` the cutover/rollout ticket). Point it at the specific downstream ticket
  that is actually gated, not the sibling that spawned it.
- **`blocked by`** — the inverse: this ticket cannot proceed until the target lands. Use for a
  hard upstream dependency (a shared API/library, a provisioning step).
- **`related`** — for tickets that share context but neither gates the other (the ticket where
  the issue was discovered, or an already-Done ticket you're referencing). Do not use `related`
  as a lazy stand-in when a real `blocks` / `blocked by` edge exists.

If a follow-up exists to remove a documented limitation in shipped work, it almost always
`blocks` the step that cannot safely happen until the limitation is gone — identify that step
explicitly rather than linking only the ticket it came from.

---

### Testing Notes (optional)

Only if not obvious from acceptance criteria.

---

### Labels / Metadata

| Field | Value |
|-------|-------|
| Type | feature / bug / chore / spike |
| Estimate | S / M / L for non-Linear trackers; **omit for Linear** |
| Component | system/component |
| Priority | P0–P3 |
| Parent | parent issue |

---

## Phase 4 — File the Ticket

If tool access is available:

1. Identify project/team
2. Set parent issue
3. Apply metadata
4. File the ticket
5. Return URL/ID

If no tool:
- Output clean Markdown
- Indicate how to file

---

## Quality Checklist

- [ ] Title ≤ 72 chars, imperative, prefixed
- [ ] At least one non-goal
- [ ] Acceptance criteria are falsifiable
- [ ] 3–6 criteria (or justified otherwise)
- [ ] No "TBD"
- [ ] Single-engineer scoped
- [ ] Parent linked (if present)
- [ ] Metadata filled

---

## Style Rules

- Plain language
- No filler
- Consistent tense
- Link instead of re-explaining
- Preserve parent intent (do not restate fully)

---

## Worked Example

### Input
"Improve retry behavior for outbound webhooks as part of the reliability epic."

### Resulting ticket

Title: [Webhooks] Add exponential backoff with jitter for delivery retries

Summary:
Outbound webhook delivery currently retries failed requests immediately, causing retry storms.
This ticket introduces exponential backoff with jitter.

Goal:
Ensure controlled retry behavior.

Non-Goals:
- Redesign queue architecture

Scope:
Modify delivery worker retry logic.

Acceptance Criteria:
1. Retryable failures use exponential backoff
2. Jitter is applied
3. Non-retryable failures are skipped
4. Logs include retry metadata

Dependencies:
Parent reliability epic

---

## References

references/linear.md  
references/jira.md  
references/github.md
