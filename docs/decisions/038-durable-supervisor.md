# ADR-038: Durable supervisor daemon, three-tool MCP surface, five native Pi tools

## Status

**Accepted** (2026-09-26). Drafted 2026-09-24 as node N0.1 of the durable-API implementation plan; owner-ratified 2026-09-25, including the post-ratification executor→MCP amendment recorded below. Acceptance rests on the completed N4.x canary evidence — provenance in *Canary evidence (C9) and rollout findings* — under the owner's fix-and-waive ruling: the one defect the canary exposed (the N2.2 launch-path `eventWriter` wiring gap) was fixed and its gate leg rerun green, and the two recorded Devin findings are carried into the rollout as ordered N5.3 work rather than waived silently. `docs/specs/durable-supervisor.md` is the normative description and carries the owner-approved contract C1–C9 and durability rules D1–D6 verbatim; this ADR records the decision and its trade-offs without duplicating the spec.

## Date

2026-09-24

## Context

Every piece of supervision state lives inside the manager's client process. The wait/job registry, the supervisor registry and Herdr event subscription, the handoff-completion gate index, and the ownership ledger are all in-memory structures in the Pi extension host or the stdio MCP host — both children of the manager's agent process. The concrete consequences:

- Supervision ends on every client restart (MCP reconnect, plugin refresh, session shutdown); unresolved runs degrade to `recovery_pending` and handoff resume is observation-only by contract.
- `launchId` is minted per call with no caller-stable key, so a launch interrupted mid-effect cannot be retried without risking a second child.
- The event path is a per-process soft receipt; ADR-027 records there is no durable queue for a dropped wake, by design.
- The runtime assembly is duplicated across the two hosts and already diverges on wake delivery.

No fix inside the client process removes these: the state must live in a process that outlives every client.

## Decision

Adopt the durable-supervisor architecture specified in `docs/specs/durable-supervisor.md`:

- **One long-lived `systemd --user` daemon per user** owns supervision, jobs, the handoff gate, durable intents, mailboxes, and launch execution. Clients are stateless proxies over one NDJSON unix socket keyed by the canonical `HERDR_SOCKET_PATH`. Each connection opens with a one-line version `hello`/`ack` on the same framing; a mismatched peer gets one bounded `PROTOCOL_MISMATCH` refusal and the connection closes with no other effect — a fresh client never silently talks to a stale daemon left running by an in-place update. The unit is committed **inactive**; activation, installed-tool changes, and profile/catalog cutover are separate owner gates.
- **Non-Pi MCP exposes exactly three tools** — launch; ownership/handoff/recovery operations; read-only own-status and unresolved intents — and **Pi exposes exactly five native tools** (`bash`, `read`, `edit`, `write`, `ask_user_question`) for global Pi and all profiles. The three tools are the universal harness surface — Claude and Devin reach them natively, Pi through the executor MCP gateway; there is no CLI surface (post-ratification amendment, recorded below). No MCP cancel or steer.
- **Durable intents before effects**, bound to (caller idempotency key, exact manager native session, canonical Task digest — `sha256` over the key-ordered JSON of the full normalized, validated Task contract, every field in): a pre-effect `recorded` intent resumes under the same `launchId`; `failed` is recorded only with evidence that no child effect exists, and any post-effect outcome with `partial` or `unknown` effect certainty — certainty the launch result preserves through the error projection — is `unresolved`, never auto-replayed, and must reconcile before transfer or claim. Reconcile closes the intent once **every** recorded replica is classified — live-bound or provably absent — with zero ambiguous, so a permanently absent child cannot strand ownership; only ambiguity holds the veto. Keys are scoped per native session: the same textual key in another session is a different binding, never a fabricated conflict. Within one session the recorded `projectRoot` participates in replay equality: the same key and session with a different digest or a different verified root is `IDEMPOTENCY_KEY_CONFLICT` — a replay never silently re-roots a launch.
- **Per-request verified identity and project root**: the thin client resolves and claims its own context; the daemon verifies the claim against a fresh `session.snapshot` and refuses on mismatch or ambiguity. Same-UID routing is cooperative — exact identity prevents accidental retargeting; it is not an authentication mechanism and none is added.
- **Owner-only filesystem mailboxes**: one file per event with a stable ID and full bounded decision evidence; mailbox read folds into the read-only status tool and ack is a run-tool operation — still an atomic rename after handling — and `acked/` retention is bounded — each ack prunes to the newest 1 000 handled records, which is not unread eviction: the no-rotation non-goal covers unhandled events; capacity is a hard bound with refusal and visible degradation, never eviction. Unpersisted-loss accounting is durable in `daemon.json`, and a gap event a still-full mailbox cannot take stays pending and is retried after room rather than dropped. Capacity counts are computed at write time under a fixed flock order — a short global mailbox-index flock, then the destination mailbox flock — so the global cap is a real bound, not a per-destination observation; journaled transfer moves always complete and count toward the successor's caps, so an over-cap destination refuses later writes until it drains. Each move fsyncs both mailbox directories, a source-absent file counts as moved only when the destination exists, and a file absent from both goes to the loss accounting rather than being skipped.
- **Restart** probes `daemon.sock` under the namespace lock — a live owner refuses the start, a provably stale path is unlinked — completes any transfer left mid-flight from its journal record, then re-matches every recorded child identity of each run in `awaiting_handoff` **or** `recovery_pending` — the state a prior host writes for unresolved runs at shutdown — against a fresh snapshot: live matches are **reattached**, provably-absent children become `unresolved(identity_lost)`, and ambiguous matches stay `recovery_pending`; then emits a `downtime_gap` event and revalidates handoff and review before any completion; it never writes a terminal state it did not observe and never blanket-marks `recovery_pending`. An absent owner pauses paid reviews while lifecycle watching continues; reviews resume on transfer or claim, and resume automatically when the recorded owner session reappears in the snapshot.
- **Owner-gated cutover**: an idle-turn consumption canary for Pi, Claude, and Devin — the Devin leg also proving an idle raw-CLI follow-up is consumed — must pass before Channels is disabled or any cutover proceeds; a failed leg stops cutover outright. Every shipped skill text that prescribes a removed tool — the manager skills and any other shipped role skill — is migrated to the reduced surface and its executor→MCP recipes before the seven-tool MCP surface is removed, and the removal is refused while any shipped skill text still prescribes one; the externally-sourced `herdr-manager` skill is prepared with that migration but landed at its canonical source — with its bundle pin refresh — only as an ordered step of the owner cutover, so no external repository is mutated before activation.

Recorded deviations:

- The filesystem mailbox **supersedes ADR-027's** "no durable queue for a dropped wake" for supervision events.
- Hints are **idle-only**, a deliberate deviation from ADR-027's no-busy-gate wake: busy, unknown, unproven, or agy panes receive nothing and rely on the mailbox.
- `HandoffProvenance` gains a **v2** shape (`owners` history) so transfer can record succession; all readers accept v1 and v2, reading v1 as single-owner history.

**Post-ratification amendment (2026-09-25).** After N0.1 owner ratification, the owner amended the harness access path — verbatim instruction: "no no, all harness should use it via executor -> MCP". C3's clause "Read and ack happen through Bash/CLI helpers" became "Read and ack happen through the three-tool MCP surface — reads through the read-only status tool, ack through the run tool", applied byte-identically in spec §3 and the implementation plan §0. The three non-Pi MCP tools are the universal harness surface for every manager kind — Pi reaches them through the executor MCP gateway — and the previously planned shell-invoked helper entry point under `bin/` is removed from the design; mailbox list/read fold into the `herdr_status` projection (a read returns the bounded event body) and `ack` is a `herdr_run` operation, the same idempotent rename-after-handling. C7 (the five native tools) and C8 (the `herdr agent prompt` follow-up recipe) are unchanged — only the daemon-access path moved.

## Alternatives considered

### Persist state inside the existing hosts

Rejected: both hosts die with the manager's agent process, so in-process durability cannot survive the restarts that motivate this change, and the duplicated runtime assembly would remain.

### Optional idempotency key

Rejected: an optional key reintroduces the interrupted-launch duplicate window the binding exists to close. The required key is a deliberate one-field extension of the ADR-037 Task contract.

### Eviction or an unbounded spool at mailbox capacity

Rejected: both hide loss. A hard bound with refusal plus `watcher_persistence_degraded` reporting makes the trade-off visible; the cost — launches refused during a long manager absence — is stated, not absorbed.

### Unbounded `acked/` history

Rejected: acknowledged files are handled records, not unread events, so the no-rotation non-goal does not cover them — and keeping them forever lets a long-lived daemon fill the filesystem. Bounded retention (the newest 1 000 per manager, pruned on each ack) keeps a handled-record window without touching unhandled events; the cost — audit history beyond the window is discarded — is stated, not absorbed.

### Reorder-only transfer without a journal record

Rejected: no ordering of the provenance rewrite, the mailbox file moves, and the two `transfer` events survives a crash between them, and none repairs a half-written event pair or distinguishes a finished transfer from an interrupted one. A durable per-transfer record — the same temp+rename+fsync primitive as the D1 intents — plus idempotent steps and a restart-resume pass is the minimal shape that makes the multi-file mutation recoverable; no generalized transaction framework is added for one caller.

### Cryptographic or token authority over the socket

Rejected: same-UID routing is cooperative. Adding auth machinery would assert a security boundary the design does not provide; per-request snapshot verification exists to prevent accidental retargeting, not to authenticate callers.

### Channels as the permanent wake path

Rejected as a default: the idle-turn canary is the gate. A failed leg stops cutover rather than silently entrenching Channels.

## Consequences

- Until the owner activates the unit, every client call refuses `DAEMON_UNAVAILABLE`; there is no in-process fallback to drift into. The cutover is a visible switch. A fresh client meeting a stale daemon after an in-place update gets one bounded `PROTOCOL_MISMATCH` refusal — visible, never silent schema drift.
- `idempotencyKey` is required: a caller that omits it gets a validation refusal, never a duplicate launch; the same key and session with a different digest or verified root is `IDEMPOTENCY_KEY_CONFLICT`, never a silent re-root.
- Steering moves from MCP tools to the `herdr agent prompt` recipe plus an owner-only follow-up file; for a `devin` child the recipe sends only to a freshly verified `idle`/`done` pane — a raw prompt to a busy Devin composer queues with no flush on this path (ADR-029) — and identity binding then rests on the manager following the recipe, not on tool enforcement.
- Mailbox capacity refusal can block launches during a long absence; events that cannot be persisted are held in memory only and are lost if the daemon stops first — the loss accounting is durable in `daemon.json` and the `downtime_gap` that discloses it is retried until the mailbox has room; payloads refused at cap stay unrecoverable.
- Operation names (`observe`/`reconcile`/`transfer`/`claim`) and the per-incident claim-record shape are review proposals; the owner contract fixes semantics, not names.

## Canary evidence (C9) and rollout findings

The C9 gate is the idle-turn consumption canary: every qualified kind must prove its pane consumes a mailbox hint as a turn before Channels is disabled or any cutover proceeds, and a failed leg stops cutover outright. The canaries ran on disposable Herdr sessions with the daemon as a plain test child process — never the production unit. Results, copied from the recorded canary runs (provenance below, no aspirational rows):

| Canary leg | Recorded result |
|---|---|
| Pi hint consumed | Exactly one `agent.prompt`, body verbatim `herdr mailbox: 2 unread (…) at <path>`; pane `working` → `idle`, the mailbox line in the transcript, `herdr_run` `ack` renamed unread→acked idempotently |
| Claude hint consumed | Same full chain green — one prompt, exact §11 body, turn consumed, acked |
| Devin hint consumed | Same chain green; plus the C8 leg — a raw `herdr agent prompt` follow-up to a verified-idle Devin pane was consumed as a turn (`workingSeen=true`), not left queued in the composer |
| AGY inert | `MANAGER_SESSION_UNAVAILABLE`, `prompts=0` — unsupported kinds are never hinted |
| Busy owner | The event persisted during the busy window; `prompts=0` (`events=1`) — hints are idle-only |
| Coalescing | `burst=4` events inside 5 s → `prompts=1` |
| Stock daemon | Empty qualified-kind set → `prompts=0` — production shipping default stays inert until the owner gate |

The canary also exposed and closed one real defect: a fresh launch-bound supervisor did not persist run-scoped mailbox events — the N2.2 `eventWriter` wiring gap (`src/daemon/runtime.ts`, `src/daemon/handlers/launch.ts`, `src/tools/launch.ts`; minimal additive reuse of the existing `MailboxEventWriter` seam). After the fix the launch-path gate leg passed with no daemon bounce — the green 8/8 run. Sibling canary evidence: restart/reattach/idempotency 7/7 (interrupted `effecting` intent → `unresolved`, closed child → `unresolved(identity_lost)` with sidecar byte-identical, live child rebound, replayed launch zero prompts, `downtime_gap` per restart, no `recovery_pending` for the matched child, owner-absent review pause); transfer/claim 7/7 (journaled transfer completing from its frozen record after a mid-move SIGKILL, complete unread-set move including mailbox-global events, `unresolved` veto, `CLAIM_NOT_INSTRUCTED` for absent/mismatched/subset/superset records, single-use instruction records).

Provenance: the canary run records — N4.1 `ebcba462-b4cf-42ce-bcb0-66288d17a22b`, N4.2 `8f850f05-2ea6-4fb5-9eaa-d1bd1ee78247`, N4.3 `0ddb124a-4fce-4cf9-b432-722eca80c1b7` — plus the owner's fix-and-waive ruling on this date.

Recorded findings (carried into the rollout, not waived silently):

1. **Devin permission posture — required for any `devin` owner.** Devin's default `auto` permission mode stalls forever on the interactive MCP-approval dialog during a mailbox-hint turn — the pane sits `blocked` and never settles. A supervised Devin owner must launch with `--permission-mode dangerous` — the same non-interactive posture AGY already uses — or ship a pre-approval mechanism. The canary's `bringUpOwner` passes it explicitly. This is a rollout requirement, not an option.
2. **Devin legacy tool surface vs the §11 hint body — an explicit N5.3 ordering note.** The hint body says "read via your MCP surface (herdr_status / executor → MCP)", but a Devin pane today exposes the legacy `herdr_*` MCP names, not `herdr_status`; the Devin leg still consumed the hint by reading the mailbox files directly. The hint text and Devin's actual surface must be reconciled — the body updated to the real surface, or the surface updated so the body is actionable as written — **at the N5.3 owner cutover, not before**: until the direct-registration removal diffs land, still-live Devin managers keep their legacy surface, and rewriting the body early would point them at tools they do not have.
