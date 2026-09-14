# ADR-028: Pane adoption for detected agents

## Status

Accepted. Extends ADR-027's wake contract. `SPEC.md` `herdr_pane`, the wake
delivery paragraph, and the error taxonomy are the normative description.

## Context

Herdr detects agents it never launched and records a complete
`agent_session` identity for them, but the pane carries no agent name. The
prompt-target join (`requirePromptTargetIdentity`) requires pane ID, terminal
ID, agent name, agent kind, and a complete `agent_session`; a detected pane
therefore fails closed as `TARGET_IDENTITY_UNAVAILABLE`. That blocked three
consumers on otherwise-healthy detected panes:

- `herdr_communicate` prompt/steer delivery,
- MCP-host self-wakes through `createMcpHostWake` (ADR-027),
- resolution by agent name for any other consumer.

A second defect surfaced during design: `interactive_ready` is a managed-agent
signal — the server emits it only for panes started through `agent start` —
so an `agent_prompted` acknowledgement from a detected or adopted pane can
never carry it. Requiring `interactive_ready:true` reported typed prompt
delivery as failed even though the bytes had landed.

## Decision

### Explicit adoption

`herdr_pane` gains `{ operation: "adopt", target, name }` — the tool's first
identity-registry mutation alongside its topology mutations. Adoption mints a
caller-supplied name satisfying the launch name grammar
(`^[a-z][a-z0-9_-]{0,31}$`) through `agent rename`, but only when the
authoritative snapshot proves exactly one agent record for the pane, a
complete `agent_session`, a `terminal_id`, a known non-`unknown`
`agent_status`, and no existing agent name. It is idempotent on the same
name, rejects a different existing name with `AGENT_ALREADY_NAMED`, and
rejects duplicates with `AGENT_NAME_TAKEN` — pre-checked against the
snapshot and mapped from a server-side `agent_name_taken` race.

After minting, a fresh snapshot plus agent/pane reads must pass the standard
prompt-target join and the verified name must equal the requested name.
Names bind to panes, not sessions: a coherent session rotation in the same
pane verifies cleanly, while contradictory or stale post-mint identity fails
closed as `TARGET_IDENTITY_CHANGED`/`TARGET_IDENTITY_UNAVAILABLE`. Consumers
requiring session-pinned identity must inspect `agent_session.value`, not the
name.

The shared implementation lives in `src/agent-identity.ts` and is consumed by
both `herdr_pane` and the wake path.

### Lazy self-adoption in the MCP host wake

`createMcpHostWake` gains a step between kind resolution and the identity
join. When the hosting pane's only missing join field is the agent name, a
`devin`, `pi`, or `claude` host attempts self-adoption once per session:
it mints `<kind>-<normalized paneId>` (lowercased, characters outside
`[a-z0-9_-]` stripped — e.g. `w6:p1Y` → `devin-w6p1y`), retries
`agent_name_taken` with suffixes `-2` through `-9`, and verifies the minted
name through the standard join before any wake bytes are sent.

The outcome is memoized: a minted name or permanent refusal is never
re-attempted; a transient read or rename failure clears the memo so the next
wake retries. The "is the pane already named" check reads the pane record
memoized by kind resolution for the session's lifetime, but the attempt
itself re-reads a fresh snapshot plus agent/pane gets and re-evaluates
`nameOnlyGap` before minting — a hand-name that arrives in between returns
`"named"` and no rename is issued. A pane missing any other
identity field, and unsupported kinds, skip the attempt. `agy` is
deliberately inert — policy does not qualify it for typed inbound delivery,
so minting it a name would only widen a boundary the owner chose to keep
closed. Note `claude` belongs to the adopt set for inbound reachability even
though its own wake rides Channels: the gate is "kinds policy qualifies for
typed inbound delivery", not "kinds the wake prompts".

### Advisory provenance tokens

Successful adopts and successful launches write
`pane report-metadata --source herdr-tools` tokens:
`identity_provenance=adopted|launched`, `identity_actor=<actor pane>`, and
`identity_session=<session value>`. These tokens are **forgeable shared
metadata** — any client can overwrite them — so they are diagnostics for
operators and inspectors only. They are never consulted for authorization,
identity verification, or delivery qualification, and a failed write degrades
to a `provenanceWarning` detail rather than failing the adopt or launch.

### Lazy target adoption in the typed tools

The same name-only gap also blocked the *target* side: `herdr_communicate`
prompt/steer, turn-control cancel/interrupt, and strict `herdr_wait` bindings
all failed closed on a detected pane that was otherwise fully identified but
unnamed. The wake's self-adopt rule is therefore generalized into
`adoptUnnamedTarget` in `src/agent-identity.ts` — the wake path now consumes
it too, so the mint-verify-stamp sequence exists exactly once.

Before each consumer's strict identity join, the caller evaluates
`nameOnlyGap` on its fresh target records. Only when the gap is `ready` —
the agent name is the sole missing join field — and the joined agent kind is
in `LAZY_ADOPT_KINDS` (`{devin, pi, claude}`, the same allowlist as
self-adopt) does the tool attempt adoption. The helper re-reads the snapshot
plus `agent get`/`pane get` so a stale caller snapshot cannot mint on
outdated evidence, mints the first free derived name, verifies the post-mint
identity through the standard join, then stamps advisory provenance with the
acting pane as `identity_actor`. The minted acknowledgement record is
appended to the caller's record set so the pending join sees the name;
every subsequent fresh read observes it natively.

Ordering is load-bearing: `herdr_communicate` runs the cooperative caller
policy (`assertSendScope`) and turn-control runs `assertControlScope` before
the adopt attempt, so a denied caller never mutates the registry, and
`assertQualifiedPromptTarget` still rejects unqualified kinds (e.g. `agy`)
before the gap check. An adopt attempt that fails or finds the gap is not
name-only falls through to the canonical `TARGET_IDENTITY_UNAVAILABLE` /
`TARGET_IDENTITY_CHANGED` refusal — adoption can widen reachability, never
weaken the join.

This is a cooperative registry mutation performed on a send/wait/control
operation: the first inbound call to a detected pane names it. The derived
name is deterministic (`<kind>-<paneId>`), the rename is verified before
bytes or keys are sent, and the provenance stamp records which pane caused
the naming — the same evidence shape an explicit `herdr_pane adopt` would
produce. If upstream Herdr ever names panes at detection time, this path
becomes a no-op: `nameOnlyGap` reports `named` and no rename is issued.

### Detection-based acknowledgement proof

`parsePromptSubmission` now requires interactivity proof, not the specific
`interactive_ready` field: `interactive_ready:true` remains the managed
proof, while an acknowledgement that omits the field is accepted only when it
carries a known live `agent_status` (`idle`, `working`, `blocked`, `done`)
and `launch_pending` is absent or exactly `false` — the one intermediate
shape, a managed agent started but not yet interactive, refuses the
detection branch, and a malformed `launch_pending` is terminal rather than
ignored.
`interactive_ready:false`, `agent_status:"unknown"`, and a missing lifecycle
status all remain fail-closed. Evidence records the discriminator as
`interactiveProof: "managed" | "detection"`.

Two honest limits on this relaxation. First, the premise that detection never
emits `interactive_ready` rests on live observation of one server version
(herdr 0.9.0: the flag appears only on launched/managed panes) plus the
server-side Active-phase semantics; a durable fix belongs upstream. Second,
the relaxation is shared by every `parsePromptSubmission` caller — including
`herdr_launch` and provisional AGY — so a managed acknowledgement that omits
the flag is now accepted on detection proof; this is pinned by a launch test
and documented in SPEC rather than gated per-caller, because the exact
identity join already binds the ack to the launched pane/terminal/name/
kind/session. Third, under a detection proof "delivered" means bytes were
written to a pane whose screen matched a detection manifest — weaker than the
server-owned `interactive_ready` marker, and a pane whose detection is fooled
could report delivered without a live agent.

## Consequences

- Detected panes become first-class prompt/wake/wait/control targets after a
  verified name binding; nothing about the identity join itself is weakened.
- The first typed inbound call to an unnamed detected pane performs a
  registry mutation (derived-name mint). It is deterministic, verified, and
  provenance-stamped, but it is a side effect on a nominally read-then-send
  operation; operators should know a prompt can name a pane.
- `herdr_pane` now mutates the agent-name registry, not only topology.
- Operators can distinguish launched from adopted panes in pane metadata,
  but must not build policy on those tokens.

## Open questions ratified

- **Label symmetry on explicit adopt.** Adopt does not rename the pane
  label. Labels are UI furniture; agent names are routing identity. Keeping
  them independent preserves the evidence that the pane was detected, not
  launched, and avoids two names drifting apart.
- **Kind gate for lazy adoption.** Restricted to `{devin, pi, claude}` —
  exactly the kinds policy qualifies for typed inbound delivery. `agy` and future unknown kinds
  stay unnamed and inert rather than acquiring a name with no delivery path.
  The allowlist is shared (`LAZY_ADOPT_KINDS`) by self-adopt and target-side
  adopt so the gate cannot drift.
