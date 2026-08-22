# ADR-013: Separate prompt submission acknowledgement from working-state observation

## Status

Superseded by `docs/decisions/015-semantic-initial-prompt-consumption-confirmation.md`
(ADR-015: Require semantic consumption confirmation for launch initial prompts).

ADR-015 retains this decision's single-submit, no-Enter, exact acknowledgement
contract for `herdr_communicate`, but replaces launch's acknowledgement-only success
with bounded semantic consumption confirmation. The older decisions referenced
below retain their unrelated active decisions:

- `docs/decisions/004-direct-prompt-steering.md` — ADR-004: Steer by direct prompt submission
- `docs/decisions/007-active-wait-job-visibility.md` — ADR-007: Show active wait jobs in Pi's footer and a toggleable widget
- `docs/decisions/008-profile-only-launch-and-bounded-fallback.md` — ADR-008: Make Herdr launch profile-only with bounded fallback

## Date

2026-08-21

## Context

Herdr 0.8.2 protocol 20 accepts stdin prompts through `agent prompt --stdin` and returns a typed `cli:agent:prompt` / `agent_prompted` success envelope. Its optional `--wait --until working` path has a separate five-second state-change observation. In a headless named session, the prompt can be accepted, rendered, and processed while that observation reports `agent_prompt_stalled`; the returned agent can be idle with `screen_detection_skipped: true`. The prompt acknowledgement and the working-state observation therefore do not prove the same fact.

Live disposable-session evidence showed the distinction:

- direct `agent prompt` without `--wait` returned `agent_prompted` with the exact pane, terminal, name/kind, complete `agent_session`, `interactive_ready: true`, and a safe `revision`, while the agent was reported idle and screen detection was skipped;
- the assignment later appeared in the Pi TUI and was processed without a second submission;
- `state_change_seq` is a lifecycle counter, not a per-prompt receipt, and `revision` can remain unchanged while the TUI catches up.

The previous Tools recovery pressed Enter after a typed stall. That could duplicate a prompt or submit an unintended key if the text had already been accepted. It also made a valid idle/skipped observation look like a delivery error.

## Decision

`herdr_communicate` prompt and steer, and `herdr_launch.initialPrompt`, use exactly one `herdr agent prompt <pane> --stdin` call without `--wait`, `--until`, or an extension-generated Enter. The health preflight gates this contract to Herdr protocol 20 on the client and running server; older protocols are incompatible and cannot reach prompt mutation.

Before every text submission, the extension reads fresh snapshot, `agent get`, and pane evidence. For `herdr_communicate`, there is no start envelope: those fresh records are the complete identity source after one strict join, and their supplied fields must agree. For `herdr_launch.initialPrompt`, real Herdr 0.8.2 may omit identity fields from `agent_started` and immediate fresh records, so launch runs one bounded, read-only identity-readiness preflight (target approximately five seconds with short polling) before stdin or recipient registration. Each sample reads all three fresh sources and is joined only with identity fields actually supplied by `agent_started`; no missing component is carried from an earlier sample. A complete start field may cover a fresh omission, but a missing start session must be supplied by one sample. In both paths the resulting identity is exact: pane ID, terminal ID, agent name, agent kind, and the complete `agent_session` object (`source`, `agent`, `kind`, and `value`). Contradictory supplied data fails immediately; timeout or caller abort fails closed with bounded evidence. This readiness window is not a prompt retry: stdin remains zero or one submission, with no Enter, runtime hook, fallback, or duplicate bytes.

### Start-envelope source of truth

The installed Herdr protocol 20 `cli:agent:start` envelope was captured during disposable
session verification. Its `result.agent` record normally supplies `pane_id`,
`terminal_id`, `name`, `agent` (the runtime kind), and the complete `agent_session`
object with `source`, `agent`, `kind`, and `value` (the live Pi source is `herdr:pi`;
Claude is `herdr:claude`), but real 0.8.2 can intermittently omit one or more of
those fields. Launch preserves and validates only the fields actually supplied by
start, then allows one bounded fresh sample to complete the identity. A malformed or
contradictory supplied field stops immediately; a missing field that never becomes
ready times out before stdin bytes. There is no compatibility fallback or prompt
submission retry.

The immediately fresh post-start snapshot, `agent get`, and pane records remain
mandatory continuity reads. Each readiness sample reads all three sources and is
evaluated as one coherent set. Launch joins that single sample with only the fields
supplied by `agent_started`; it never carries a terminal, name, kind, or session
component from an earlier sample. A complete start field may cover an omitted/null
fresh field, but a session absent from start must appear in that same sample. Every
supplied fresh field must match the start identity and every repeated field within the
sample must agree. Any contradiction is an immediate zero-dispatch refusal; bounded
identity timeout or caller abort is also fail-closed. The acknowledgement, optional
post-observation, and recipient registry are then bound to the captured complete
identity; neither a pane/name/kind match nor a fresh omission can repair or replace it.

A delivery is confirmed only by a valid success envelope with:

- `id: "cli:agent:prompt"` and `result.type: "agent_prompted"`;
- the exact captured pane ID, terminal ID, agent name/kind, and all four `agent_session` fields;
- `interactive_ready: true`; and
- a safe non-negative `revision`.

The acknowledgement is compared against the captured identity, not merely against a pane/name/kind selector. A same-name/kind replacement or pane reuse therefore cannot acknowledge the prompt.

The extension retains safe `state_change_seq` and `screen_detection_skipped` metadata when present, but neither field is used as a prompt receipt. A failed, malformed, or identity-mismatched acknowledgement fails closed. The extension never retries a submission, falls back to argv, invokes a runtime hook, sends Enter, or submits duplicate bytes.

After a confirmed submission, fresh agent and pane reads are an optional paired post-observation. Their identity must still match the captured terminal/session before state is reported; a missing, malformed, or replaced identity becomes an `unavailable` observation and never describes the replacement process. A replaced `postState` and success-row state are omitted; only bounded mismatch evidence may remain in the observation. The observation reports `working`, `not_working`, `unknown`, `detection_skipped`, `stale`, or `unavailable`. An idle/done/blocked state, `screen_detection_skipped: true`, an unchanged/older revision, or an unavailable read does not revoke the atomic submission acknowledgement and does not claim turn completion. A post-read failure is visible in structured observation evidence; the sender-authored body and stdin process text remain excluded from diagnostics.

Named-key operations remain a separate lower-level raw control-input escape hatch. The existing named-key allowlist, including `esc`, `escape`, and `ctrl+c`, is unchanged; those direct `send-keys` calls do not claim prompt acknowledgement, turn settlement, or causal verification. Attachment recipient registrations persist pane ID, terminal ID, name, kind, and the complete session object; optional `agent_id` is diagnostic only, so same-name/pane replacement is rejected. Communication remains sequential, and all existing sender provenance, target identity, ownership, attachment, abort, and bounded-evidence contracts remain in force. Model-visible identity/session strings are bounded while full values remain internal for exact comparison.

## Alternatives considered

### Keep `--wait --until working` as delivery confirmation

Rejected. Herdr can accept the prompt and still fail the optional working observation in headless panes, producing a false intermittent error.

### Press Enter once after a typed stall

Rejected. A stall only proves that the requested observation was not seen; it does not prove that the text was not accepted. A recovery key can duplicate a complete assignment or alter the target's input state.

### Resubmit through direct prompt after a stall

Rejected. Without a turn-level receipt, a second submission is unsafe and cannot be made idempotent by Tools.

### Require a newer `revision` or `state_change_seq`

Rejected. `revision` is terminal observation metadata and can remain unchanged while the TUI processes input; `state_change_seq` is a lifecycle counter and is not scoped to a newly submitted prompt.

## Consequences

- Prompt delivery no longer reports a false failure when Herdr's working-state screen detection is skipped or stale.
- Successful details distinguish `submission.confirmed` from `observation.status`, so callers cannot mistake acceptance for a working transition or completion.
- Prompt acknowledgement failures remain fail-closed, and created launch resources remain visible without automatic cleanup.
- Stdin privacy is stronger because the adapter no longer parses or retains a prompt-stall sequence hint; failures expose only bounded non-textual stream metadata.
- A future Herdr turn receipt could provide stronger completion/consumption evidence, but Tools does not synthesize it from terminal state, revision, or sequence counters.
