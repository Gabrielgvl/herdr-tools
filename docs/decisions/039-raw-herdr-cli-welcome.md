# ADR-039: Raw `herdr` CLI welcome for pane-level work

## Status

**Accepted** (2026-09-26), by standing owner decision — verbatim instruction: "raw cli is always welcome now".

## Date

2026-09-26

## Context

The durable-supervisor cutover (ADR-038) left the shipped skills with a near-blanket ban on the raw `herdr` CLI: the only sanctioned shell invocation was the `herdr agent prompt` follow-up recipe, and every other pane-level verb — inspection, cleanup, turn control — collapsed into "report to the owner". Two pressures made that ban costly:

- **Degraded-path report loss.** A leaf worker whose Task supplied no handoff path was told to leave its report visibly in its own pane and stop — never raw CLI. When the manager pane was busy, a result wake could be refused (`TARGET_BLOCKED`), and the worker had no permitted way to leave even a one-line pointer; reports sat unread in a pane nobody was watching.
- **No turn-control path.** With no MCP cancel, interrupt, or steer, a misbehaving child could only be reported, not stopped — yet the raw `herdr agent send-keys` verbs already implement the safe contract ADR-014 fixed: one named key (`esc` cancel, `ctrl+c` interrupt), against a freshly verified `working` target, with no retries or escalation.

The owner's standing permission resolves both: pane-level raw CLI is normal operator tooling, and the trust boundary is the daemon's three-tool MCP surface, not the shell.

## Decision

The raw `herdr` CLI is welcome for pane-level work, as a standing owner permission:

- messaging with `herdr agent prompt <TARGET> <TEXT>` — the existing follow-up recipe, owner-only pointer files, and the `devin` idle/done rule are unchanged;
- inspection with `herdr agent get|list|read|explain` and `herdr pane get|list`;
- cleanup with `herdr pane close`, scoped to panes this session launched that have handed off;
- turn control with `herdr agent send-keys <TARGET> esc` (cancel) or `ctrl+c` (interrupt) — sent exactly once, only after a fresh `herdr agent get` shows the target `working`, then re-read; never escalate keys blindly.

What does not change:

- Daemon operations — launch, run, status, ack — go only through the three-tool MCP surface (`herdr_launch`, `herdr_run`, `herdr_status`; via the executor→MCP gateway in Pi). The daemon has no CLI equivalent.
- A raw `herdr agent start` creates an unsupervised child — no intent, handoff, or mailbox — so it is used only when the owner explicitly asks for an unsupervised pane.
- No native subagents or `Task` tool for Herdr work, and no direct tmux control.

**Mandatory safety rule.** Before any write to a pane — prompt or keys — re-read it with `herdr agent get` and send only when its state allows it: `idle` or `done` for a prompt, `working` for cancel or interrupt. Never write into a `blocked` pane: an owner menu or permission prompt is showing there and keystrokes would answer it. Never write into an unknown or unproven state either.

In the degraded reply path, a worker with no handoff path leaves its report visibly in its own pane and may additionally send the manager pane one pointer line with `herdr agent prompt`, under the same rule — a fresh `idle` read first, never `blocked`, `working`, unknown, or unproven.

## Alternatives considered

### Keep the blanket raw-CLI ban

Rejected: it is what lost the reports. A worker on the degraded path had no permitted mechanism to point the manager at its own pane, so a `TARGET_BLOCKED`-refused wake meant an invisible report; and a misbehaving child could not be stopped without owner intervention even though a safe one-key contract exists.

### Restore MCP tools for pane operations

Rejected: the seven-tool surface was deliberately reduced to three at the daemon cutover — every operation on it carries the supervision contract (durable intents, provenance envelopes, mailbox events) that pane reads and one-shot keys do not need. The raw CLI already reaches the same authoritative pane state; re-expanding the daemon surface would add machinery without adding safety.

## Consequences

- Daemon operations stay MCP-only because that is where the contract lives: idempotency keys, provenance envelopes, durable intents, and mailbox events exist only on the three-tool surface. A CLI path carries none of them — which is exactly why `herdr agent start` yields an unsupervised pane rather than a managed child.
- The blocked-pane rule exists because `blocked` means an owner menu or permission prompt is on screen: input written there can answer the owner's prompt rather than reach the agent. The `TARGET_BLOCKED` failures made the same point from the other side — pane state must be re-read fresh before each write, never assumed.
- Turn-control and follow-up correctness rest on the caller following the re-read rule, not on tool enforcement — the same posture ADR-038 records for the follow-up recipe's identity binding.
- `herdr pane close` is scoped to panes the closing session launched that have handed off; closing another session's pane remains outside the permission, matching the standing rule that no session mutates a resource another session owns.
- The shipped skills are updated to the new wording — manager, harness-flow, planner, worker, scout, researcher, reviewer, promoter — and the generated `profile-plugins` copies are regenerated from canonical sources, never hand-edited.
