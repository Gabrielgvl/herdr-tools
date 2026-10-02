# Runbook: lane-retirement dry run (gate for `HERDR_TOOLS_RETIRE_ENABLED=1`)

ADR-040 (amended 2026-10-02) keeps retirement at `HERDR_TOOLS_RETIRE_ENABLED=0` until this dry run passes. In dry-run mode the daemon runs the entire proof chain, journals `would_retire` for a lane it would have closed, and closes nothing.

## Setup

- Deploy the amendment with `HERDR_TOOLS_RETIRE_ENABLED=0` (unset or empty is the same).
- Run for at least 6 hours and at least 20 handed-off lanes across all three structured kinds (Claude, Pi, Devin).
- Capture daemon stderr: every decision change is one `herdr-tools-daemon lane_retire run=<id> decision=<d> reason=<r>` line; the gate journals `herdr-tools handoff_trace_history run=<id> decision=capture_failed reason=<r>` when a fingerprint capture fails.
- Observe per-run views through `herdr_status` (`run.retire = { state, reason, stableForMs }`).

## Prompt transports

`herdr_run` cannot submit text (observe / reconcile / transfer / claim / ack only). Use exactly:

- **Live daemon:** the agent prompt channel — `AgentPromptClient.prompt(paneId, text, signal)` through `cli.prompt` (the daemon's own repair-prompt channel); operator form: the C8 agent-prompt recipe in `test/hotfix/mcp.stdio.hotfix.test.ts`.
- **Daemon downtime:** raw `herdr pane run <pane> "<text>"` (herdr's CLI, independent of the daemon). `herdr pane send-text` only with an explicit Enter.
- **Verification of every control:** count user turns with a timestamp at or after the sidecar's `artifact.mtimeMs` in the native trace before and after the send and record the delta. A prompt not visible in the trace is itself a finding.

## Criteria

Each criterion names the journal fields that prove it.

1. **Anchors and fingerprints exist.** Every post-deploy `handed_off` sidecar has `artifact.mtimeMs` ≤ the artifact file's current mtime, a non-null `sha256`, and an `artifact.traceHistory` whose `kind` matches the child (`claude-jsonl`, `pi-jsonl`, `devin-session`). Any sidecar with an anchor but no fingerprint shows `refused trace_history_missing`, and its gate journal line explains the capture failure.
2. **Live follow-up (per kind).** Hand off; send via the agent prompt channel while the daemon is up. Expected: `decision=refused reason=cycle_reopened` (the live mark, written before the sweep reaches the trace check), persisting across a restart until re-acceptance; **never** `would_retire`. `trace_follow_up` is *not* expected here.
3. **Downtime / post-restart follow-up (per kind).** Hand off; stop the daemon; send via `herdr pane run`; start the daemon. Expected: `decision=refused reason=trace_follow_up` on the first sweep that finds the child present; never `would_retire`. Variant: restart first, then send — same expectation.
4. **Positive control.** Untouched lane: `watching` → `would_retire` after the grace with no `trace_*`/`composer_*` reason; `herdr_status` shows `run.retire = { state: "disabled", stableForMs ≥ graceMs }`.
5. **Write-to-acceptance window (per kind).** Deliver the follow-up immediately after the artifact file appears and before `handed_off` is recorded (watch the sidecar). Expected after a restart: `refused trace_follow_up` (the follow-up's time ≥ `mtimeMs`), never `would_retire`.
6. **Partial-record control (JSONL kinds).** On a fixture copy of a test lane's session file — never a live lane's — append an unterminated user record: `refused trace_pending_tail`; complete the line: `trace_follow_up`.
7. **Re-acceptance advances the anchor.** Follow-up on a live-supervised lane, let it write a **new** artifact and re-hand off: `cycle_reopened` → `watching` → `would_retire`; the sidecar's `artifact.version` and `artifact.mtimeMs` both increased, and the follow-up's time < the new `mtimeMs`.
8. **Devin queued-composer canary.** Deliver a prompt mid-turn so it lands in the composer queue; let the turn end and the artifact be accepted; do not press Enter; restart the daemon. Expected: `refused composer_queued` on every sweep through a full grace, never `would_retire`. **Deciding evidence:** inspect the ATIF document after acceptance. If the queued text is a `source:"user"` step with time ≥ `mtimeMs`, the trace also covers queued input and the ADR records the guard as redundant defence; if absent, the guard is the only defence and this criterion becomes a permanent regression test. The guard ships either way.
9. **Byte-identical rewrite control.** Hand off; **stop the daemon**; send a follow-up via `herdr pane run`; have the child rewrite the same artifact bytes (file mtime advances, sidecar `mtimeMs` must not); start the daemon: `refused trace_follow_up` persists; only a changed artifact (new `sha256`, new `mtimeMs`) clears it.
10. **Unsupported kinds.** Zero `would_retire` for `agy`; each shows `trace_unsupported_kind`.
11. **No sweep faults, cadence held.** Zero `decision=sweep_error` / `sweep_unavailable` attributable to the new checks; sweep duration under the 60 s cadence at production lane count. (Each present lane costs one fstat and one read of at most 8 MiB per sweep; the optional Devin verdict cache is built only if this criterion shows cadence pressure.)
12. **Legacy lanes.** Every pre-deploy `handed_off` run shows only `trace_anchor_missing`; the owner closes or `retention=keep`-marks them before the flip.
13. **Rollback control.** Devin: hand off, stop the daemon, send a follow-up via `herdr pane run`, then `/revert` the session to a step before the artifact write, start the daemon: `refused trace_source_rewritten` on every sweep, never `would_retire`. JSONL kinds: on a fixture copy of a test lane's session file (never a live lane's), truncate the file below the fingerprint offset: `trace_source_rewritten`; rewrite the anchored KiB with same-length different bytes: `trace_source_rewritten`.
14. **Trace trust on the deployed host.** Every present Pi and Devin lane reaches the scan (no blanket `trace_source_unreadable`). The shared trust chain refuses symlinks, world-writable nodes, foreign owners and swapped inodes; group-writable session files (the agent CLIs' own `002` umask, `-rw-rw-r--` on the reference host) are trusted. A host whose session files are world-writable fails this criterion and must fix its umask, not the rule.

Only when 1–14 hold does the manager set `HERDR_TOOLS_RETIRE_ENABLED=1`, with a 24 h watch of `decision=retired` lines against `lane_retired` mailbox events.
