# ADR-040: Daemon-owned lane retirement for finished handoff lanes

## Status

Accepted. Ratified 2026-10-01 as Design B of the RAM-improvements review (`ram-improvements-20261001/ht-design.md`), with owner rulings: retirement mode is **pane close**; the `HERDR_TOOLS_RETIRE_ENABLED` kill switch stays unset/`0` = dry-run until the operator enables it at deploy; grace default 15 minutes, sweep cadence 60 seconds; `released` runs never retire; the B5 orphan process-group sweep is not built.

## Date

2026-10-01

## Context

An accepted handoff ends the work, not the lane: after a run reaches `handed_off`, its child agent, its pane, and its per-session sidecars stay alive until a human closes them. Finished lanes accumulate as pane clutter and hold roughly 300–900 MiB apiece in agent process memory; a substantial share of unread mailbox events belongs to lanes that already settled. The run record, the supervisor's settlement bookkeeping, and the accepted artifact are all durable — what lingers is only the interactive surface.

Closing a pane is destructive: a wrong close kills a live agent or a manager pane mid-work. Any automation here must prove, not infer, that the lane it closes is exactly the one the finished run recorded — and must never improvise a lifecycle state the durable record does not carry.

## Decision

The daemon runs a **lane-retirement sweep** on its own cadence (`HERDR_TOOLS_RETIRE_SWEEP_MS`, default 60 s), starting after the server binds. One sweep runs at a time — a tick that falls due while the last is still holding a pane lock or readback is skipped, and an in-flight sweep drains before the §4 shutdown steps.

**Trigger and grace.** A run is a candidate only while its sidecar reads `handed_off`. `released`, `cancelled`, `failed`, `recovery_pending`, and `awaiting_handoff` are never candidates. Eligibility requires a stability clock: the sweep keeps in-memory state keyed by `runId` and closes only after observing, for the whole grace period (`HERDR_TOOLS_RETIRE_GRACE_MS`, default 15 min), the child continuously `idle` or `done` with an unchanged `state_change_seq` **and** an unchanged digest of its detection screen. The lifecycle tuple is the **agent record's own** status and counter, admitted only when the supervision join (`joinTargetRecords`, the record-level rule of `classifySnapshotTarget`) proves it coherent with the pane record — a stale pane record saying `idle`/5 beside a fresh agent record saying `working`/6 is a contradiction that defers, never an observation; a missing agent status or counter defers the same way, and the pane's scalars never stand in for them. The screen digest is the independent inactivity proof: every sweep reads `herdr pane read <pane> --source detection --format text` and hashes it, so an agent that keeps working while its lifecycle fields lag (the known Devin stale-status behaviour after a raw follow-up, durable-supervisor §10) still resets the clock the moment anything prints. The clock resets when the pane disappears, the status goes `working` or `blocked`, the counter or the digest changes, or the screen cannot be read in full (a failed or truncated read is a deferral, not a digest); a daemon restart resets it conservatively — observation, not a new durable timestamp, carries the proof.

**Environment.** `HERDR_TOOLS_RETIRE_ENABLED`, `HERDR_TOOLS_RETIRE_GRACE_MS`, `HERDR_TOOLS_RETIRE_SWEEP_MS`, and `HERDR_TOOLS_RETIRE_FOCUS_DEFERS` treat an empty string as unset. The grace must be positive and the sweep at least 1 000 ms; anything else — including the `0` an empty `Environment=` line would otherwise collapse to — falls back to the default rather than zeroing the safety grace or spinning the sweep.

**Proof chain.** Each sweep takes one fresh `api snapshot` and evaluates every run dir against it, in order:

1. The sidecar parses, lifecycle is `handed_off`, and `terminalId` + `nativeSession` are bound. The provenance record is read next: only a **genuinely missing** record is a legacy run (no owner history, the launch manager pane as the topology fallback); a malformed, untrusted, oversized, or unreadable record refuses with `provenance_unreadable`, because it may hide a `retention: "keep"` or a transferred owner.
2. The exact recorded child identity matches exactly one pane in the snapshot; absent or ambiguous matches never close.
3. The agent record's lifecycle tuple, proven coherent with the pane record, is `idle` or `done`, and its counter and the detection-screen digest have been observed unchanged through the grace.
4. The merged launch tokens prove `identity_provenance = launched` and an `identity_session` equal to the sidecar's native session.
5. The child is not a manager: `manages_children`, `unmarked`, and `adopted` classifications refuse; the child's own intent ledger (`intents.list(childKey)`, read directly) must hold no open intent — `recorded` counts as open, since a launch request executes under that state before it turns `effecting` — and no nonterminal recorded child, and its mailbox must be drained.
6. The run's **current** owner — resolved from provenance v2, falling back to the recorded manager pane — must survive the close: `paneCloseTopology` validation runs before any effect; `PROTECTED_RESOURCE` refuses and `TOPOLOGY_INVALID` defers.
7. A `focused` pane defers, but only for a bounded number of sweeps (`HERDR_TOOLS_RETIRE_FOCUS_DEFERS`, default 60) — a stale focus flag cannot park a finished lane forever.

**Effect.** The close runs under the shared cross-process pane-write lock **and** the run's native flock — the lock every ownership transfer and sidecar mutation takes — so a transfer cannot interleave between the proof and the effect. Under both locks, immediately before dispatch, the sweep re-proves the whole chain against fresh reads: the sidecar still reads `handed_off` for the matched child; `pane get`/`agent get` still carry the recorded identity, the launch tokens, a coherent idle/done lifecycle and the clock's exact counter (present and unchanged — a vanished counter defers); the provenance is re-read and the **current** owner re-resolved; the child's intent ledger and mailbox are re-checked; the owner topology is re-validated against a fresh snapshot; the pane is not focused within its bound; the detection-screen digest is re-read and must equal the sweep's; and `lease.check()` proves the pane lock is still held (a dead flock holder or an untrusted lock path defers with `pane_lock_lost`). Every one of these refusals defers without spending a close attempt. Only then does it mark `selfClose.begin(paneId)` so the bound supervisor correlates the close instead of waking on it, and close through `closeWithReadback` so the absence is proven, not assumed. The `lane_retired` write happens after the run flock releases, because the mailbox resolves the owner under that same flock. A close failure or `MUTATION_UNCERTAIN` retries on the next two sweeps, then the run's view becomes `failed` — with no retirement event.

**Kill switch.** `HERDR_TOOLS_RETIRE_ENABLED` unset or `0` runs the entire chain as a dry run that journals `would_retire` and closes nothing; the operator enables it at deploy.

**Evidence.** A proven close — one whose own mutation response the readback confirmed, `reconciled === false` — writes exactly one `lane_retired` run-scoped event to the run's current owner (durable-supervisor §7), carrying the child identity, the `{state:"handed_off", artifactSha256}` handoff record, and `actions` naming the closed pane and the artifact path. The bound supervisor's own-close ledger suppresses the `pane_closed` wake, and `JobRegistry` consults the retirer's `retiredByDaemon(runId)` marker so a daemon-retired lane emits `lane_retired` instead of a redundant `job_terminal` — while a `handed_off` run closed by any other mechanism still emits `job_terminal`. A **reconciled absence** — the close dispatch errored but the readback found the pane already gone — proves absence, not authorship: it is another actor's close in the race window, so the sweep sets neither the marker nor the own-close confirmation, writes no `lane_retired`, journals `close_reconciled_absent`, and lets the supervisor's own `pane_closed` path settle the run with its `job_terminal`; the next sweep observes the absence and stops tracking the run. The sweep's per-run decision view projects through `herdr_status` as `run.retire` (`watching`, `eligible`, `deferred`, `refused`, `retired`, `failed`, `kept`, `disabled`) with its reason, so a refusal is auditable rather than silent.

**Opt-out — `retention`.** The ADR-037 Task contract gains `retention?: "retire" | "keep"` (additive amendment). Omitted or `"retire"` permits retirement; `"keep"` parks the lane indefinitely with view `kept`. The field never enters routing, Jev evidence, pane identity, or the rendered handoff contract — provenance preserves it and recovery launches carry it forward, and a provenance record that cannot be read refuses rather than forgetting the opt-out. A cooperative `retention=keep` pane token is the in-band fallback for lanes launched before the field existed, or for any lane whose task cannot be relaunched. Nothing in the package writes that token; the owner sets it by hand:

```
herdr pane report-metadata <pane> --source owner-retention --token retention=keep
```

The dedicated `--source owner-retention` keeps the herdr-tools identity tokens (`identity_provenance`, `identity_actor`, `identity_session`, written under `--source herdr-tools`) intact — reporting under the package's own source would replace them. The sweep reads the merged token on the pane and agent records, so the lane turns `kept` on the next sweep. A token-kept lane is re-read every sweep, so `--clear-token retention` under the same source releases it: a kept lane accrues no grace, so clearing the token restarts the full stability window and the lane can retire only after a fresh grace. Only the token keep is reversible this way; a lane kept by the task field `retention: "keep"` is terminal for the daemon's lifetime and no pane token releases it.

## Residual risk

The inactivity proof is an observation of the terminal, not of the agent's process. Two bounds are stated, not hidden:

- **A silent worker.** An agent whose lifecycle fields have gone stale (`idle`/`done` with a frozen `state_change_seq`) *and* whose work prints nothing to the detection region of the screen for the entire grace, while its mailbox and intent ledger stay empty and no owner holds it, is indistinguishable from a finished lane and will be closed once the kill switch is on. The grace bounds the window; the digest catches every visible keystroke, spinner, log line, or prompt redraw inside it. An owner who knows a lane works silently must mark it `retention: "keep"` (task field or the pane-token command above).
- **A noisy idle lane.** A lane whose detection region changes without work — a clock, a blinking indicator rendered into that region, a shell that redraws its prompt — never accumulates the grace. That is a liveness cost, not a safety one: the lane stays open and its `retire` view reads `watching` with `stableForMs` resetting, which `herdr_status` makes visible to the owner, who can close it by hand.

Neither bound weakens the proof chain's other gates: a lane that is a manager, holds unread events, is the run's current owner, or sits inside the owner's topology still refuses regardless of its screen.

## Alternatives considered

### Client-side cleanup on wake

Rejected: the manager process that would run cleanup dies with the session; pane clutter accrues precisely when nobody is watching. Retirement must live in the process that already outlives every client — the same reason supervision durability moved there (ADR-038).

### Sidecar timestamp + unconditional close after N minutes

Rejected: a timestamp proves the handoff was accepted, not that the pane is still the same agent. The proof chain exists because a recycled or adopted pane on the same terminal must never close; observation-based stability plus exact token matching is what separates a finished lane from a live one wearing its seat.

### Reaping process groups (B5)

Deferred, not built: terminating the child's process group reaches further than pane close and needs its own proof shape. This ADR covers pane close only; orphan sweep remains future work.

### Emitting `job_terminal` for retired lanes too

Rejected: the retired lane already settled its durable outcome at handoff acceptance, and `lane_retired` carries the close evidence; a second terminal event is bookkeeping noise in the mailbox the retire work exists to drain. Suppression is marker-gated (`retiredByDaemon`), so narrowing it cannot silence a settlement the daemon did not itself cause.
