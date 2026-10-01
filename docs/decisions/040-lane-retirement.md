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

**Trigger and grace.** A run is a candidate only while its sidecar reads `handed_off`. `released`, `cancelled`, `failed`, `recovery_pending`, and `awaiting_handoff` are never candidates. Eligibility requires a stability clock: the sweep keeps in-memory state keyed by `runId` and closes only after observing the pane continuously `idle` or `done` with an unchanged `state_change_seq` for the grace period (`HERDR_TOOLS_RETIRE_GRACE_MS`, default 15 min). The clock resets when the pane disappears, the status goes `working` or `blocked`, or the seq changes; a daemon restart resets it conservatively — observation, not a new durable timestamp, carries the proof.

**Proof chain.** Each sweep takes one fresh `api snapshot` and evaluates every run dir against it, in order:

1. The sidecar parses, lifecycle is `handed_off`, and `terminalId` + `nativeSession` are bound.
2. The exact recorded child identity matches exactly one pane in the snapshot; absent or ambiguous matches never close.
3. The pane is `idle` or `done` and has been observed stable through the grace.
4. The merged launch tokens prove `identity_provenance = launched` and an `identity_session` equal to the sidecar's native session.
5. The child is not a manager: `manages_children`, `unmarked`, and `adopted` classifications refuse; a child whose own manager session has live intents or an undrained mailbox refuses.
6. The run's **current** owner — resolved from provenance v2, falling back to the recorded manager pane — must survive the close: `paneCloseTopology` validation runs before any effect; `PROTECTED_RESOURCE` refuses and `TOPOLOGY_INVALID` defers.
7. A `focused` pane defers, but only for a bounded number of sweeps (`HERDR_TOOLS_RETIRE_FOCUS_DEFERS`, default 60) — a stale focus flag cannot park a finished lane forever.

**Effect.** The close runs under the shared cross-process pane-write lock, re-reads the pane and agent records under the lock, re-proves identity, tokens, status, and seq before dispatching, marks `selfClose.begin(paneId)` so the bound supervisor correlates the close instead of waking on it, and closes through `closeWithReadback` so the absence is proven, not assumed. A close failure or `MUTATION_UNCERTAIN` retries on the next two sweeps, then the run's view becomes `failed` — with no retirement event.

**Kill switch.** `HERDR_TOOLS_RETIRE_ENABLED` unset or `0` runs the entire chain as a dry run that journals `would_retire` and closes nothing; the operator enables it at deploy.

**Evidence.** A proven close writes exactly one `lane_retired` run-scoped event to the run's current owner (durable-supervisor §7), carrying the child identity, the `{state:"handed_off", artifactSha256}` handoff record, and `actions` naming the closed pane and the artifact path. The bound supervisor's own-close ledger suppresses the `pane_closed` wake, and `JobRegistry` consults the retirer's `retiredByDaemon(runId)` marker so a daemon-retired lane emits `lane_retired` instead of a redundant `job_terminal` — while a `handed_off` run closed by any other mechanism still emits `job_terminal`. The sweep's per-run decision view projects through `herdr_status` as `run.retire` (`watching`, `eligible`, `deferred`, `refused`, `retired`, `failed`, `kept`, `disabled`) with its reason, so a refusal is auditable rather than silent.

**Opt-out — `retention`.** The ADR-037 Task contract gains `retention?: "retire" | "keep"` (additive amendment). Omitted or `"retire"` permits retirement; `"keep"` parks the lane indefinitely with view `kept`. The field never enters routing, Jev evidence, pane identity, or the rendered handoff contract — provenance preserves it and recovery launches carry it forward. A cooperative `retention=keep` pane token is the in-band fallback for lanes launched before the field existed.

## Alternatives considered

### Client-side cleanup on wake

Rejected: the manager process that would run cleanup dies with the session; pane clutter accrues precisely when nobody is watching. Retirement must live in the process that already outlives every client — the same reason supervision durability moved there (ADR-038).

### Sidecar timestamp + unconditional close after N minutes

Rejected: a timestamp proves the handoff was accepted, not that the pane is still the same agent. The proof chain exists because a recycled or adopted pane on the same terminal must never close; observation-based stability plus exact token matching is what separates a finished lane from a live one wearing its seat.

### Reaping process groups (B5)

Deferred, not built: terminating the child's process group reaches further than pane close and needs its own proof shape. This ADR covers pane close only; orphan sweep remains future work.

### Emitting `job_terminal` for retired lanes too

Rejected: the retired lane already settled its durable outcome at handoff acceptance, and `lane_retired` carries the close evidence; a second terminal event is bookkeeping noise in the mailbox the retire work exists to drain. Suppression is marker-gated (`retiredByDaemon`), so narrowing it cannot silence a settlement the daemon did not itself cause.
