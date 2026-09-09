# TDD Plan: Global Pi Herdr Tools

## Scope and non-goals

This plan is the tests-first contract for a new global extension at
`/home/gabriel/.pi/agent/extensions/herdr-tools/`. `herdr-tools` is a standalone
Git repository rooted at that directory; it is not a package inside the Courier
repository and its commands, coverage configuration, and integration fixtures
must resolve from this repository root. The extension registers **exactly seven**
tools:

1. `herdr_inspect`
2. `herdr_communicate`
3. `herdr_wait`
4. `herdr_jobs`
5. `herdr_launch`
6. `herdr_pane`
7. `herdr_tab`

`herdr_command`, `herdr_workspace`, and `herdr_admin` are deferred. They must not
be registered, advertised, or called by this package. Do not edit
`herdr-question-alert.ts` or the Herdr-managed `herdr-agent-state.ts`.

This is a plan only. No implementation code is part of this change.

## Governing TDD contract

Follow `/home/gabriel/workspace/courier/.pi/skills/tdd/source-skill.md`:

- Write each test before the implementation slice it specifies.
- Run the new test red and verify that it fails for the intended missing behavior,
  not because of a malformed fixture or test harness.
- Make the smallest implementation change that turns the slice green.
- Refactor only while green.
- End with clean tests, build, lint, and 100% coverage on every changed source
  file. Record any deviation rather than silently weakening a test.
- Do not add compatibility aliases, fuzzy matching, generic fallbacks, or hidden
  cleanup behavior.

Pi extension constraints from `docs/extensions.md` and the extension examples:

- Register tools with `pi.registerTool()` and the normal execute signature
  `(toolCallId, params, signal, onUpdate, ctx)`.
- Use `pi.exec("herdr", argv, { signal })`; never construct a shell command string.
- Return Pi's structured `content` plus machine-readable `details`; throw only
  for a genuine whole-call error that must be marked `isError`.
- Use `StringEnum` for string enum parameters and a compact `Text` renderer for
  `renderCall`/`renderResult`.
- Use the supplied `AbortSignal` for every CLI and reviewer operation.
- Do not start background processes or timers from the extension factory. Start
  session-scoped behavior from lifecycle/tool execution and clear it on session
  replacement.

## Invariants and terminology

- **Herdr enabled:** registration and execution are available only when
  `process.env.HERDR_ENV === "1"`. Disabled mode must not call Herdr or touch UI.
- **Target:** an explicit opaque ID, `current` resolved from the caller's Herdr
  context, or a unique exact label/agent name. Exact means case-sensitive and
  whole-string. No prefix, substring, case-folded, display-number, or focused-pane
  fallback is permitted.
- **Authoritative read:** after every mutating command, use the ID returned by the
  command response and read the resulting resource from Herdr before returning it
  or using it for a dependent mutation. Never predict an ID.
- **Current Courier workspace:** the workspace/pane represented by the caller's
  Herdr environment. It is always protected by the tests and is never used for
  integration setup or cleanup.
- **Owned resource:** a pane/tab/resource tree created by this extension during
  the current in-memory Pi session, with every transitive descendant still owned.
  Ownership is not persisted in session entries.
- **Reviewer:** one independent, tool-less, in-process model review per target for
  a wait that passes the configured review interval. It is not a Herdr pane or
  agent and receives only bounded metadata and transcript deltas.

The implementation must resolve the exact Herdr CLI syntax from the installed
binary's help output. Unit tests assert logical operation, argv tokens, returned
IDs, and safety flags without hard-coding predicted IDs.

Global wait-review settings are owned by this extension in
`/home/gabriel/.pi/agent/extensions/herdr-tools/config.json`. Do not read or
write Pi's settings file for these values: Pi has no extension namespace there.
Do not add project-local settings, per-tool settings, or tool-call overrides.

## Acceptance-invariant trace

Every row maps an acceptance statement to a named test and requires both positive
and negative assertions. “No mutation” includes no mutating CLI invocation, no
focus change, no UI prompt, no ownership change, and no current-Courier change.

| Criterion | Test name(s) | Expected mutation | Expected non-mutation |
|---|---|---|---|
| Register only inside Herdr | `registers_exactly_seven_tools_when_herdr_env_is_1`; `registers_no_tools_and_makes_no_calls_when_herdr_env_is_not_1` | The Pi registry contains exactly the seven named tools in enabled mode. | Disabled mode registers none of the seven, invokes no CLI, and makes no UI call. |
| Only the seven core tools are in scope | `does_not_register_deferred_command_workspace_or_admin_tools` | None beyond the seven registrations. | Registry and CLI trace contain no deferred tool or deferred operation. |
| All Herdr calls use `pi.exec` CLI | `uses_pi_exec_with_herdr_argv_not_shell_commands` | Fake `pi.exec` receives `command: "herdr"` and an argv array. | No shell string, `execSync`, raw socket, or direct process call is used. |
| Every call receives the tool AbortSignal | `passes_the_same_abort_signal_to_every_cli_call`; `passes_abort_signal_to_reviewer` | Runner/reviewer observe the supplied signal. | No operation silently substitutes an unabortable signal. |
| Use explicit returned IDs | `chains_mutations_using_returned_opaque_ids`; `never_constructs_ids_from_display_numbers` | Dependent reads/mutations target IDs returned by fixtures. | Predicted IDs, sidebar indexes, workspace suffixes, and stale IDs never appear in argv. |
| Mutations are followed by authoritative reads | `authoritative_post_read_follows_create_split_move_and_launch`; `authoritative_read_wins_over_stale_mutation_response` | Returned result contains the post-read resource. | A stale create/split/start response is never returned as current state. |
| Target IDs/current/exact unique labels or agent names only | `resolves_exact_id_current_and_unique_exact_name`; `current_resolves_from_caller_context_not_focus` | The intended exact resource is selected. | Missing, ambiguous, fuzzy, case-variant, and focused-only selectors cause zero mutation. |
| Missing and ambiguous targets fail closed | `missing_target_fails_before_mutation`; `ambiguous_exact_agent_name_fails_before_mutation` | A structured target-resolution error is returned. | No prompt, steer, split, launch, focus, close, or wait-side effect occurs. |
| Inspect default is one target plus metadata and 100 recent-unwrapped lines | `inspect_single_defaults_to_metadata_and_exactly_100_recent_unwrapped_lines` | A single authoritative snapshot contains target metadata and the last 100 lines. | It does not read an unbounded transcript or silently use rendered/soft-wrapped output. |
| Inspect collections stay compact | `inspect_collection_returns_compact_records_without_transcripts` | Collection metadata is returned for each requested collection. | Collection inspection does not read per-pane transcripts or inflate output to single-target detail. |
| Health includes version and protocol | `inspect_health_returns_version_and_protocol` | Health details contain both fields from the CLI. | Health does not mutate Herdr or invent a protocol value when absent. |
| Inter-agent text has mandatory provenance | `communicate_wraps_prompt_and_steer_with_v1_sender_envelope`; `launch_wraps_initial_prompt_as_assignment`; `message_envelope_preserves_payload_and_sanitizes_metadata` | Recipient text begins with the exact v1 header, authoritative sender name/label/kind plus pane ID, kind, agent authority boundary, then the unchanged payload. | No caller-controlled metadata, provenance opt-out, unlabeled communicate text, or mislabeled launch assignment is delivered. |
| Sender resolution is authoritative and self-send is rejected | `communicate_sender_precedence_name_label_kind_pane`; `communicate_missing_caller_fails_before_send`; `communicate_self_target_fails_before_send`; `launch_missing_caller_fails_before_mutation` | Name→label→kind→pane-only precedence is deterministic; caller pane must exist in the fresh snapshot; communicate target differs from caller. | No invented identity, stale/environment-only sender, self-message, placement, agent start, or prompt occurs after a failed sender preflight. |
| Prompt fails while target is working | `communicate_prompt_rejects_working_agent_without_mutation` | A structured precondition failure is returned. | No prompt, interrupt, focus, or confirmation occurs. |
| Steer submits directly without interruption | `communicate_steer_direct_for_idle_done_blocked_working`; `communicate_steer_never_sends_escape`; `communicate_working_steer_omits_wait_flags` | Idle/done/blocked/working steer submits exactly once through `agent prompt --stdin`; working input is interpreted by the target agent TUI and uses no wait flags. | Unknown/malformed state sends zero bytes; no steer path sends Escape, Enter, duplicate text, or waits for settlement. |
| Prompt/steer separate atomic acknowledgement from observation | `communicate_prompt_verifies_working_without_waiting_completion`; `communicate_steer_verifies_working_without_waiting_completion`; strict identity mismatch/missing/replacement cases; `communicate_replacement_post_state_is_not_authoritative` | Fresh snapshot plus agent-get/pane evidence must establish exact pane/terminal/name/kind and complete `agent_session`; one typed `agent_prompted` response with that exact identity confirms acceptance; paired post-reads may report working, non-working, skipped, stale, or unavailable. | Missing, malformed, contradictory, or replaced identity sends zero prompt bytes; a replaced post-state is absent from `postState` and the success row and survives only as bounded mismatch evidence; normal prompt refuses working; steer submits directly; neither waits for completion, retries, or sends Enter. |
| Explicit turn control is strict and identity-bound | `turn_control_schema_is_strict`; `turn_control_requires_working_snapshot_and_agent_get`; `turn_control_requires_exact_stable_identity`; `turn_control_dispatches_exactly_one_control_key`; `turn_control_waits_fixed_window_and_always_final_snapshots`; `turn_control_confirms_advanced_same_agent_state`; `cancel_disappearance_is_unconfirmed`; `interrupt_agent_exit_requires_strict_absence_proof`; `turn_control_abort_before_dispatch_is_aborted`; `turn_control_abort_after_dispatch_preserves_evidence`; `turn_control_errors_are_stable`; `turn_control_mcp_schema_and_fifo_parity`; `turn_control_rendering_and_redaction_are_bounded`; `turn_control_disposable_integration` | `cancel` sends exactly one `esc`; `interrupt` sends exactly one `ctrl+c` only after both authoritative reads prove the same working pane/terminal/full session identity. A fixed 5,000 ms wait and independent final snapshot confirm a terminal same agent or the narrowly proven interrupt `agent_exited` state. | No extra fields, retries, escalation, fallback, focus, synthetic causality, cancel-on-disappearance, or generic success is possible. Abort before dispatch is `ABORTED`; after dispatch, independent bounded verification retains evidence.
| Communicate uses named keys and no confirmation | `communicate_uses_named_keys_only`; `communicate_never_calls_confirmation_ui` | Only caller-requested validated named keys are sent. | No synthesized Escape, raw control bytes, arbitrary key bytes, or UI confirmation is sent. |
| Wait supports single and multi-target any/all | `wait_supports_single_target`; `wait_multi_target_any_returns_first_match`; `wait_multi_target_all_waits_for_every_match` | The matching target set and snapshots are returned. | Any does not wait for unrelated targets; all does not return before every target matches. |
| Wait supports semantic and raw conditions | `wait_matches_semantic_condition`; `wait_matches_raw_literal`; `wait_matches_raw_regex`; `wait_combines_raw_and_semantic_conditions` | A condition is satisfied only by the requested predicate. | Raw state is not inferred from text, and literal matching is not accidentally regex matching. |
| Wait timeout is explicit and capped | `wait_requires_explicit_timeout`; `wait_accepts_timeout_of_3600_seconds`; `wait_rejects_timeout_above_3600_seconds` | Valid timeout starts a bounded detached operation. | Missing, zero/invalid, or over-limit timeout starts no poll or reviewer. |
| Wait operation vocabulary is explicit | `wait_acknowledges_accepted_phase`; `wait_settles_with_terminal_wait_result`; `wait_rejects_legacy_job_fields` | Jobs expose only `accepted|running|cancel_requested|settled`; terminal jobs expose one `wait_result` from the replacement enum. | No generic job field or completion-overloaded alias is published, and `wait_result` is absent before settlement. |
| Timeout includes structured snapshots | `wait_timeout_returns_structured_timed_out_result` | The settled job has `wait_result: "timed_out"`, `matched: false`, and latest bounded per-target snapshots. | Timeout is never represented as `condition_met` or an empty generic error. |
| Wait cancellation is truthful | `wait_cancellation_aborts_polling_and_returns_cancelled`; `wait_cancellation_cannot_apply_late_result`; `wait_cancellation_reports_unknown_when_drain_is_unproven` | In-flight work observes the fence and only observed quiescence yields `wait_result: "cancelled"`; uncertainty yields `unknown`. | No later poll, reviewer, focus, mutation, or false condition match occurs after cancellation. |
| Waits over the configured interval require review | `wait_over_configured_interval_starts_reviewers`; `wait_over_native_wait_uses_composite_reviewer_refresh`; `wait_under_configured_interval_starts_no_review` | One reviewer per target starts after the configured threshold; native waits are segmented so review supervision is not bypassed. | A per-call threshold cannot bypass or change the configured gate, and reviewer observations cannot satisfy a native predicate. |
| Reviewer config defaults and bounds are fixed | `review_interval_defaults_to_five_minutes`; `review_interval_accepts_only_one_to_thirty_minutes`; `review_interval_is_not_a_wait_argument`; `review_model_defaults_to_luna_low_and_is_not_a_wait_argument` | Extension-owned config supplies the reviewer cadence and model. | Tool input cannot override interval, model, or thinking; out-of-range config fails before waiting. |
| Extension-owned config path is authoritative | `settings_read_only_from_extension_owned_config`; `settings_do_not_read_pi_or_project_config`; `settings_do_not_read_tool_override_fields`; `project_config_override_is_absent`; `tool_settings_override_is_absent` | The loader reads only `/home/gabriel/.pi/agent/extensions/herdr-tools/config.json`. | Pi settings, project config, environment fallback, and tool arguments cannot supply or override these settings. |
| Absent config uses defaults | `absent_config_uses_default_cadence_and_reviewer_model` | Missing `config.json` yields cadence `5` minutes and model `luna` with fixed thinking `low`. | No file is created, no warning is converted into a mutation, and no per-call override is accepted. |
| Valid config is loaded | `valid_config_loads_cadence_and_reviewer_model` | A valid extension-owned JSON file supplies the configured cadence/model for a wait. | The loader does not coerce unrelated fields or read a project/tool override. |
| Malformed JSON fails closed | `malformed_config_json_returns_invalid_settings_before_waiting` | The wait returns `INVALID_SETTINGS` with the config path/error context. | No Herdr poll, reviewer call, fallback defaults, or config rewrite occurs. |
| Cadence validation is strict | `invalid_cadence_below_one_fails_before_waiting`; `invalid_cadence_above_thirty_fails_before_waiting`; `invalid_cadence_noninteger_fails_before_waiting` | Invalid config returns `INVALID_SETTINGS`. | Values are not clamped, rounded, or silently replaced with defaults; no CLI/reviewer work starts. |
| Reviewer model validation is strict | `invalid_reviewer_model_fails_before_waiting`; `unresolvable_reviewer_model_ends_long_wait_without_fallback` | Invalid syntax fails as `INVALID_SETTINGS`; an unavailable configured model ends a required review as `REVIEWER_FAILED`. | No fallback model, project setting, tool argument, or pane reviewer is used. |
| Config reload follows the SPEC sampling rule | `config_change_is_sampled_by_next_wait`; `active_wait_keeps_its_start_config_snapshot` | Each new wait observes the current valid `config.json`; an active wait keeps its validated start snapshot. | A file change does not mutate an active wait mid-flight, and reload does not persist ownership or create resources. |
| Reviewers are independent, concurrent, and uncapped | `starts_one_toolless_reviewer_per_target`; `starts_all_reviewers_concurrently`; `reviewer_target_count_has_no_artificial_cap` | Every target gets one independent in-process review, including a large fixture set. | No reviewer pane, Herdr agent, serial target bottleneck, or arbitrary target cap is introduced. |
| Reviewer input is bounded and delta-based | `reviewer_receives_bounded_metadata_and_transcript_delta`; `reviewer_delta_excludes_prior_transcript`; `reviewer_input_contains_no_tools_or_actions` | Only the specified bounded current metadata and new transcript delta are passed. | Full scrollback, unrelated panes, tool definitions, UI handles, and action methods are absent. |
| Reviewer terminal findings end a wait | `reviewer_stalled_ends_wait_early`; `reviewer_blocked_ends_wait_early`; `reviewer_risk_ends_wait_early`; `reviewer_unknown_ends_wait_early`; `reviewer_failure_ends_wait_early` | Wait ends with the finding/failure and latest snapshots. | No further poll, prompt, pane, focus, or automatic remediation follows. |
| Reviewer healthy result continues normally | `healthy_reviewer_does_not_fake_a_predicate_match` | Ordinary polling continues until the authoritative predicate matches or times out. | An advisory review is not returned as a target match and does not create a pane.
| Launch is profile-only | `launch_rejects_raw_kind_argv_and_env_schema`; `launch_accepts_arbitrary_valid_named_profile`; `launch_validates_agent_and_profile_name_patterns` | A valid named Pi/Claude profile starts in the selected Herdr pane. | Raw kind, argv, and env launch fields cannot bypass the profile contract. |
| Launch requires a unique name | `launch_requires_nonempty_name`; `launch_rejects_duplicate_exact_name_before_creation`; `launch_rejects_ambiguous_name_before_creation` | A unique named launch is allowed. | Duplicate/ambiguous names do not create a tab, pane, process, or focus change. |
| Launch defaults label/name and placement safely | `launch_defaults_label_to_name`; `launch_defaults_right_no_focus_and_current_cwd` | Defaults are included in creation argv. | Default launch never focuses, changes cwd, or selects a different direction. |
| Launch supports tab/pane placement | `launch_can_create_new_tab`; `launch_can_use_existing_exact_pane`; `launch_rejects_conflicting_tab_and_pane_targets` | Only the requested returned tab/pane receives the agent. | No inferred tab/pane, focused-pane fallback, or unrelated resource mutation occurs. |
| Launch acknowledges one atomic prompt submission and reports observation separately | `launch_optional_prompt_waits_for_ready_then_verifies_working`; `launch_prompt_does_not_wait_for_completion`; `launch_fresh_post_start_snapshot_join_precedes_dispatch`; `launch_replacement_post_state_is_not_authoritative`; delayed identity readiness; perpetual omission timeout; coherent-sample contradiction; replacement; caller abort; exact zero/one stdin counts | Real Herdr protocol 22 `agent_started` may omit pane/terminal/name/kind/`agent_session` fields. Before dispatch or no-prompt return, a bounded read-only identity-preflight window (target approximately five seconds with short polling) freshly reads snapshot, agent-get, and pane per sample and joins only that coherent sample with fields actually supplied by start. A complete start field may cover a fresh omission, but a missing start session must arrive in one sample; missing components are never merged across samples. Once one sample yields exact pane/terminal/name/kind/full session, the same captured identity is persisted for attachment recipients and used for one no-wait submission; typed `agent_prompted` evidence confirms acceptance only when it matches that identity, and paired post-reads report working, idle, skipped, stale, or unavailable observation. | Missing readiness, timeout, caller abort, malformed data, contradictory evidence, or a replaced identity stops before prompt bytes and recipient registration with bounded evidence; a replaced post-state is omitted from authoritative details/rows and never registers as the recipient; the readiness window is not a prompt retry, so prompt is not sent early, duplicated, recovered with Enter, or routed through a runtime hook/fallback; launch does not claim a working transition or wait for completion. |
| Launch fallback is bounded and schema-real | `launch_requires_real_start_failure_envelope_for_fallback`; `launch_requires_unknown_status_and_empty_agent_fields_for_fallback`; `launch_correlates_returned_name_pane_and_agent_kind` | Only the real `cli:agent:start` failure envelope plus an `agent_status: unknown` no-agent pane proof permits fallback. | Timeouts, malformed envelopes, identity/kind mismatches, contradictory panes, and prompt failures never retry. |
| Launch never auto-cleans resources | `launch_success_never_closes_resources`; `launch_partial_failure_preserves_created_resources`; `session_shutdown_does_not_auto_cleanup` | Created resources remain available for explicit user/admin handling. | No implicit close/delete on success, failure, cancellation, reload, or shutdown. |
| Pane creation requires a label and safe defaults | `pane_create_requires_label`; `pane_create_defaults_right_and_no_focus`; `pane_create_honors_explicit_down_and_focus` | Labeled pane is created with requested direction/focus. | Missing label fails before CLI mutation; defaults never focus. |
| Tab creation requires label and honors focus | `tab_create_requires_label`; `tab_create_defaults_no_focus`; `tab_create_honors_explicit_focus` | Labeled tab is created and post-read. | Missing label and omitted focus never mutate/focus. |
| Pane/tab close is explicit, sequential, and bounded | `herdr_pane_close_is_sequential_and_autonomous`; `herdr_tab_close_is_sequential_and_autonomous`; `close_lost_response_reconciles_or_is_uncertain` | Only an explicit exact close dispatches close, followed by a fresh compact post-read. | No implicit cleanup, retry, modal confirmation, or protected-resource close occurs. |
| Ownership is current-session in-memory only | `ownership_records_only_current_session_resources`; `ownership_is_not_persisted_in_session_entries` | Created resource IDs are tracked in memory. | No `appendEntry`, file, global, or resumed-session ownership state is written. |
| Ownership clears on lifecycle replacement | `ownership_clears_on_reload`; `ownership_clears_on_resume`; `ownership_clears_on_new_session`; `ownership_clears_on_session_change` | A new session begins with an empty ownership set. | Old IDs cannot authorize close after replacement. |
| Exact pane/tab close is autonomous after protected-topology validation | `pane_close_unowned_without_ui`; `tab_close_unowned_without_ui`; `close_protects_caller_resources`; `close_rejects_malformed_topology` | Any exact non-caller target may close after fresh topology validation, with Herdr-returned operation IDs and compact post-state. | No modal confirmation or ownership gate exists; caller resources and malformed topology remain protected. |
| Close preserves completed mutations and reconciles uncertain responses | `close_preserves_completed_mutation_after_abort`; `close_reconciles_lost_response_when_absent`; `close_uncertain_when_present_or_readback_fails` | Fresh independent post-read proves absence or returns `MUTATION_UNCERTAIN` with bounded evidence. | No generic success, blind retry, or `No result provided` terminal result is returned. |
| Current Courier resources are protected | `ownership_cannot_claim_current_courier_resource`; `integration_cleanup_never_targets_current_courier_tree` | Only disposable test IDs may be cleaned by explicit test teardown. | Current workspace/tab/pane IDs remain byte-for-byte unchanged. |
| Results, renderers, cancellation, and partial failures are truthful | `results_include_structured_details_and_compact_text`; `renderers_are_compact_by_default`; `partial_results_preserve_each_target_truth`; `renderers_show_wait_settlements_and_error_states`; `all_late_races_are_non_mutating` | Each result exposes its operation phase, terminal wait result when settled, IDs, snapshots, and errors suitable for the LLM and renderer. | No raw JSON dump, swallowed per-target error, false condition match, or late side effect is shown. |
| Unit and integration safety gates exist | `unit_harness_uses_fakes_only`; `integration_uses_disposable_named_session_not_current_courier`; `coverage_gate_requires_changed_files_at_100_percent` | Disposable integration state is created and explicitly torn down by the test harness. | Unit tests never control real Herdr; integration never creates in the Courier workspace. |

## Extension-owned global configuration

`herdr-tools` is a standalone Git repository rooted at
`/home/gabriel/.pi/agent/extensions/herdr-tools`. Its global wait-review
configuration is owned by the extension at the absolute path
`/home/gabriel/.pi/agent/extensions/herdr-tools/config.json`. Pi settings must
not be used for these values because Pi has no extension namespace. The loader
must not consult project config, environment values, or tool-call fields.

The settings contract under test is:

- missing `config.json`: defaults to `reviewCadenceMinutes: 5`,
  `reviewerModel: "openai-codex/gpt-5.6-luna"`, and fixed reviewer thinking `low`;
- valid JSON: loads the documented cadence/model values without coercion;
- malformed JSON: fails closed with `INVALID_SETTINGS` before Herdr or reviewer
  work, and never rewrites the file;
- cadence: an integer in inclusive range `1..30`; below `1`, above `30`, and
  noninteger values are invalid, not clamped or rounded;
- reviewer model: a nonempty valid model identifier that resolves through the
  injected model registry; invalid or unresolvable values have no fallback;
- no project-level or tool-call override exists; any such supplied value is
  ignored or rejected and cannot change the extension-owned settings;
- because the SPEC specifies cadence sampling for each wait, each new wait reads
  a fresh validated settings snapshot, while an active wait retains the snapshot
  captured at its start if `config.json` changes.

No config file is created when absent, and no config reload mutates ownership or
creates/cleans Herdr resources. If the implementation adds an explicit reload
hook, it must obey the same validation and snapshot rules; otherwise the
next-wait sampling tests are the reload contract.

## Proposed test seams and fake fixtures

The implementation should expose or inject narrow test seams rather than making
unit tests spawn Herdr or call a real model:

### Extension-owned settings loader

The settings seam must read exactly
`/home/gabriel/.pi/agent/extensions/herdr-tools/config.json`. This is an
extension-owned global file in the standalone `herdr-tools` repository. It is
not Pi's settings file, because Pi has no extension namespace, and it is not a
project-local file. The loader must distinguish a missing file from malformed
JSON and invalid values:

- missing `config.json` returns defaults `{ reviewCadenceMinutes: 5,
  reviewerModel: "openai-codex/gpt-5.6-luna", reviewerThinking: "low" }` without creating the file;
- valid JSON accepts only the documented settings shape and preserves the
  configured values without coercion;
- malformed JSON returns `INVALID_SETTINGS` before any Herdr or reviewer call;
- cadence must be an integer in the inclusive range `1..30`; values below `1`,
  above `30`, and nonintegers are invalid;
- reviewer model must be a nonempty valid model identifier and must resolve via
  the injected model registry before a required review; there is no fallback;
- project config, Pi settings, environment values, and `herdr_wait` input cannot
  override these settings;
- each new wait samples a validated settings snapshot. A wait already in flight
  keeps its start snapshot if `config.json` changes; a config change does not
  mutate active reviewer cadence or model.

The settings fake records every attempted file path, file read, write, model
resolution, and input field. It fails if any path other than the extension-owned
absolute path is read or if the loader creates/rewrites the absent or malformed
file. The fake filesystem supplies these cases independently: absent file,
valid file, malformed JSON, cadence `0`, cadence `31`, cadence `5.5`, invalid
model identifier, and a valid file changed between two waits.

### Fake command runner

The fake records, for every call:

- command (`herdr`), argv tokens, and exact options;
- the received `AbortSignal` identity and aborted state;
- fixture response, exit code, stderr, and whether the call was cancelled;
- a controllable barrier for ordering/race tests.

It must support queued responses, a response function keyed by logical command,
forced CLI failure, delayed completion, and an abort-aware pending call. The fake
must reject a shell string, raw key bytes, a missing signal, or an ID not present in
the fixture registry so unsafe behavior fails loudly.

### Fake model reviewer

The fake records one request per target and exposes a barrier so tests can prove
concurrent start. It accepts only bounded review input and an `AbortSignal`; it
has no command runner, tool list, pane ID, UI, or action callback. It can return
`healthy`, `stalled`, `blocked`, `risk`, `unknown`, or a structured failure.

The model adapter test fixes the configured model to `luna/low` and verifies that
wait input cannot replace it. The real Luna provider need not be called by unit
suite tests.

### Fake context and clock

The fake context supplies caller IDs and may omit UI entirely because explicit
pane/tab close is autonomous. Tests assert that no confirmation callback is
looked up or invoked. A monotonic fake clock controls poll intervals, the review
threshold, timeout, and same-tick races; tests must not sleep in real time.

### JSON fixture samples

These are representative fixture contracts. Exact CLI envelope fields may be
adapted to the installed Herdr version, but the test meanings and safety fields
must remain stable.

#### `health.json`

```json
{
  "ok": true,
  "version": "6.0.0",
  "protocol": 6
}
```

#### `pane-single.json`

```json
{
  "pane": {
    "pane_id": "w9:p27",
    "tab_id": "w9:t4",
    "workspace_id": "w9",
    "label": "reviewer",
    "cwd": "/tmp/herdr-tools-it",
    "agent": "reviewer",
    "agent_status": "working",
    "revision": 42
  },
  "read": {
    "source": "recent-unwrapped",
    "line_count": 100,
    "lines_first": ["line-038"],
    "lines_last": ["line-137"]
  }
}
```

The actual fixture generator contains 137 ordered lines and asserts that the
returned slice is exactly lines 38 through 137, not a 100-line approximation.

#### `collections-compact.json`

```json
{
  "workspaces": [{"workspace_id": "w9", "label": "it"}],
  "tabs": [{"tab_id": "w9:t4", "workspace_id": "w9", "label": "reviewer"}],
  "panes": [{"pane_id": "w9:p27", "tab_id": "w9:t4", "label": "reviewer", "agent_status": "working"}]
}
```

#### Returned-ID mutation and authoritative post-read fixtures

```json
{
  "split_response": {
    "ok": true,
    "pane": {"pane_id": "w9:p27", "label": "reviewer"}
  },
  "post_read": {
    "pane_id": "w9:p27",
    "label": "reviewer",
    "direction": "right",
    "focused": false,
    "cwd": "/tmp/herdr-tools-it",
    "agent_status": "idle",
    "revision": 43
  }
}
```

The test deliberately makes `split_response` stale (`agent_status` omitted) and
requires the post-read fixture to be returned. `w9:p27` must be used verbatim;
no ID may be derived from `w9`, `p27`, or display order.

#### `wait-snapshots.json`

```json
{
  "snapshots": [
    {
      "target": "w9:p27",
      "metadata": {"agent_status": "working", "revision": 51},
      "transcript_delta": ["still running"],
      "observed_at_ms": 300000
    },
    {
      "target": "w9:p28",
      "metadata": {"agent_status": "blocked", "revision": 12},
      "transcript_delta": ["Need credentials"],
      "observed_at_ms": 300000
    }
  ]
}
```

#### `reviewer-results.json`

```json
{
  "review_requests": [
    {
      "target": "w9:p27",
      "metadata": {"agent_status": "working", "revision": 51},
      "transcript_delta": ["still running"],
      "transcript_delta_line_count": 1,
      "tools": null
    }
  ],
  "results": [{"target": "w9:p27", "classification": "stalled", "reason": "no progress"}]
}
```

The test additionally supplies a transcript delta larger than the configured
bound and asserts truncation before the model call, with no full transcript in
the request.

#### Partial and timeout results

```json
{
  "operation_phase": "settled",
  "wait_result": "failed",
  "targets": [
    {"target": "w9:p27", "target_evidence": {"kind": "identity_unknown", "observedAtMs": 52, "targetGenerationRef": "target_generation_opaque", "currency": "historical_non_current", "source": "composite_observation"}},
    {"target": "w9:p28", "error": {"code": "CLI_FAILED", "message": "read failed"}}
  ]
}
```

```json
{
  "operation_phase": "settled",
  "wait_result": "timed_out",
  "latest_snapshots": [{"target": "w9:p27", "agent_status": "working", "revision": 52}],
  "matched": false
}
```

## Exact tests grouped by module and tool

The following names are required. A test may cover more than one trace row, but
renaming or dropping a required test is a TDD-plan deviation.

### `settings.test.ts`, `registration.test.ts`, and `cli-runner.test.ts`

#### `settings.test.ts` / extension-owned `config.json`

- `settings_read_only_from_extension_owned_config`
- `settings_do_not_read_pi_or_project_config`
- `settings_do_not_read_tool_override_fields`
- `project_config_override_is_absent`
- `tool_settings_override_is_absent`
- `absent_config_uses_default_cadence_and_reviewer_model`
- `valid_config_loads_cadence_and_reviewer_model`
- `malformed_config_json_returns_invalid_settings_before_waiting`
- `invalid_cadence_below_one_fails_before_waiting`
- `invalid_cadence_above_thirty_fails_before_waiting`
- `invalid_cadence_noninteger_fails_before_waiting`
- `invalid_reviewer_model_fails_before_waiting`
- `unresolvable_reviewer_model_ends_long_wait_without_fallback`
- `config_change_is_sampled_by_next_wait`
- `active_wait_keeps_its_start_config_snapshot`
- `settings_loader_does_not_create_or_rewrite_config`

The valid fixture uses the extension-owned file shape:

```json
{
  "wait": {
    "reviewCadenceMinutes": 10,
    "reviewerModel": "luna"
  }
}
```

The absent fixture has no `config.json` and expects cadence `5`, model `luna`,
and fixed thinking `low`. Malformed JSON, cadence values `0`, `31`, and `5.5`,
and invalid model values such as `""`, whitespace, or a malformed identifier
must fail before any Herdr poll or reviewer call. A project fixture with a competing setting and a tool input containing cadence,
model, or thinking fields must be absent from the settings source and must be
ignored or rejected, never used as an override. The reload tests follow the SPEC
sampling rule: a subsequent wait sees a changed valid file, while an active wait
uses the validated snapshot captured at its start.

#### `registration.test.ts` and `cli-runner.test.ts`

- `registers_exactly_seven_tools_when_herdr_env_is_1`
- `registers_no_tools_and_makes_no_calls_when_herdr_env_is_not_1`
- `does_not_register_deferred_command_workspace_or_admin_tools`
- `uses_pi_exec_with_herdr_argv_not_shell_commands`
- `passes_the_same_abort_signal_to_every_cli_call`
- `rejects_non_json_cli_output_as_structured_cli_error`
- `rejects_nonzero_cli_exit_as_structured_cli_error`
- `chains_mutations_using_returned_opaque_ids`
- `never_constructs_ids_from_display_numbers`
- `authoritative_post_read_follows_create_split_move_and_launch`
- `authoritative_read_wins_over_stale_mutation_response`
- `cancellation_between_mutation_and_post_read_does_not_report_success`

### `targets.test.ts`

- `resolves_exact_id_current_and_unique_exact_name`
- `current_resolves_from_caller_context_not_focus`
- `resolves_exact_agent_name_only_when_unique`
- `missing_target_fails_before_mutation`
- `ambiguous_exact_agent_name_fails_before_mutation`
- `rejects_fuzzy_prefix_target`
- `rejects_substring_target`
- `rejects_case_variant_target`
- `does_not_use_focused_pane_when_target_is_omitted`
- `target_resolution_error_contains_candidates_without_mutating`

### `inspect.test.ts` / `herdr_inspect`

- `inspect_single_defaults_to_metadata_and_exactly_100_recent_unwrapped_lines`
- `inspect_single_requests_recent_unwrapped_source`
- `inspect_single_preserves_authoritative_post_read_metadata`
- `inspect_collection_returns_compact_records_without_transcripts`
- `inspect_collection_does_not_read_transcripts`
- `inspect_health_returns_version_and_protocol`
- `inspect_missing_target_returns_structured_error_without_mutation`
- `inspect_never_changes_focus_or_ownership`

### `communicate.test.ts` / `herdr_communicate`

- `communicate_wraps_prompt_and_steer_with_v1_sender_envelope`
- `communicate_sender_precedence_name_label_kind_pane`
- `communicate_missing_caller_fails_before_send`
- `communicate_self_target_fails_before_send`
- `message_envelope_preserves_payload_and_sanitizes_metadata`
- `communicate_prompt_rejects_working_agent_without_mutation`
- `communicate_prompt_sends_text_without_wait_flags`
- `communicate_prompt_verifies_working_without_waiting_completion`
- `communicate_steer_direct_for_idle_done_blocked_working`
- `communicate_steer_never_sends_escape`
- `communicate_steer_uses_prompt_submission`
- `communicate_working_steer_omits_wait_flags`
- `communicate_unknown_state_sends_no_bytes`
- `communicate_does_not_prompt_after_resolution_failure`
- `communicate_completion_race_returns_verified_working_or_truthful_error`

### `turn-control.test.ts` / explicit cancel and interrupt

- `turn_control_schema_is_strict`
- `turn_control_requires_working_snapshot_and_agent_get`
- `turn_control_requires_exact_stable_identity`
- `turn_control_requires_fresh_agent_get_pane_id_without_snapshot_fallback`
- `turn_control_rejects_identity_change_before_dispatch`
- `turn_control_rejects_regressed_fresh_sequence_before_dispatch`
- `turn_control_dispatches_exactly_one_escape_for_cancel`
- `turn_control_dispatches_exactly_one_ctrl_c_for_interrupt`
- `turn_control_waits_for_idle_blocked_done_or_unknown_with_fixed_5000ms_window`
- `turn_control_always_performs_independent_final_snapshot_after_wait_failure`
- `turn_control_confirms_same_agent_only_with_advanced_state_change_seq`
- `cancel_disappearance_is_cancel_unconfirmed`
- `interrupt_agent_exited_requires_acknowledged_dispatch_and_strict_absence`
- `interrupt_absence_scan_rejects_flattened_legacy_and_malformed_session_evidence`
- `interrupt_does_not_claim_causality`
- `turn_control_abort_before_dispatch_is_aborted`
- `turn_control_abort_after_dispatch_uses_independent_verification`
- `turn_control_abort_after_successful_dispatch_retains_evidence_and_final_snapshot`
- `turn_control_never_retries_or_escalates`
- `turn_control_details_are_bounded_and_rendered_compactly`
- `turn_control_mcp_schema_matches_pi_and_fifo_serializes_calls`
- `turn_control_evidence_is_redacted`

The fixture carries pane ID, terminal ID, and the complete `{source, agent, kind,
value}` session object in both the snapshot and `agent get` response. Fresh
`agent get` fixtures also vary missing and mismatched pane IDs, and sequence
fixtures cover snapshot 10/fresh 9/final 10 without dispatch plus binding to the
freshest non-regressed sequence. Tests vary state, identity, wait failure,
caller abort timing, pane movement, replacement agents, disappeared panes,
legacy/flattened/malformed session evidence, and agent-free unknown panes. The
operation key call count must remain exactly one in every dispatched case.

### `wait-predicates.test.ts`, `wait-orchestration.test.ts`, and `herdr_wait`

- `wait_supports_single_target`
- `wait_multi_target_any_returns_first_match`
- `wait_multi_target_all_waits_for_every_match`
- `wait_matches_semantic_state_condition`
- `wait_matches_raw_literal_output`
- `wait_matches_raw_regex_output`
- `wait_combines_raw_and_semantic_conditions`
- `wait_literal_does_not_enable_regex_semantics`
- `wait_regex_uses_explicit_regex_mode_only`
- `wait_requires_explicit_timeout`
- `wait_accepts_timeout_of_3600_seconds`
- `wait_rejects_timeout_above_3600_seconds`
- `wait_rejects_nonpositive_or_nonfinite_timeout`
- `wait_returns_structured_timed_out_result_with_latest_snapshots`
- `wait_timed_out_result_does_not_report_condition_met`
- `wait_acknowledges_accepted_operation_phase`
- `wait_settles_with_terminal_wait_result`
- `wait_rejects_legacy_job_fields`
- `wait_cancellation_aborts_polling_and_returns_cancelled`
- `wait_cancellation_cannot_apply_late_result`
- `wait_cancellation_reports_unknown_when_drain_is_unproven`
- `wait_polling_uses_authoritative_reads`
- `wait_missing_target_fails_before_polling`
- `wait_ambiguous_target_fails_before_polling`
- `wait_partial_target_failures_preserve_per_target_truth`
- `wait_and_timeout_same_tick_follow_documented_precedence`
- `wait_reviewer_and_match_race_returns_one_terminal_settlement`
- `wait_native_predicates_use_occupant_pinned_agent_wait`
- `wait_native_reviewer_refresh_is_composite_only`
- `wait_target_evidence_is_historical_and_generation_bound`

### `reviewer.test.ts` / mandatory wait reviewer

- `review_interval_defaults_to_five_minutes`
- `review_interval_accepts_only_one_to_thirty_minutes`
- `review_interval_out_of_bounds_fails_configuration`
- `review_settings_are_snapshotted_for_each_wait`
- `review_interval_is_not_a_wait_argument`
- `review_model_defaults_to_luna_low`
- `review_model_is_not_a_wait_argument`
- `wait_under_configured_interval_starts_no_review`
- `wait_over_configured_interval_starts_reviewers`
- `starts_one_toolless_reviewer_per_target`
- `starts_all_reviewers_concurrently`
- `reviewer_target_count_has_no_artificial_cap`
- `reviewer_receives_bounded_metadata_and_transcript_delta`
- `reviewer_delta_excludes_prior_transcript`
- `reviewer_input_contains_no_tools_or_actions`
- `reviewer_receives_abort_signal`
- `reviewer_stalled_ends_wait_early`
- `reviewer_blocked_ends_wait_early`
- `reviewer_risk_ends_wait_early`
- `reviewer_unknown_ends_wait_early`
- `reviewer_failure_ends_wait_early`
- `healthy_reviewer_does_not_fake_a_predicate_match`
- `reviewer_is_not_rendered_as_or_launched_in_a_pane`
- `reviewer_cancellation_cannot_finish_after_wait_cancellation`

The concurrency test uses a barrier: all reviewer requests must enter before any
is released. The no-cap test uses a generated target set larger than any expected
UI or implementation batch limit and verifies one request per target.

### `launch.test.ts` / `herdr_launch`

- `launch_rejects_raw_kind_argv_and_env_schema`
- `launch_accepts_arbitrary_valid_named_profile`
- `launch_validates_agent_and_profile_name_patterns`
- `launch_validates_typed_override_enums`
- `launch_reports_effective_primary_overrides_and_normalized_paths`
- `launch_uses_120_second_startup_timeout_with_cli_margin`
- `launch_requires_real_start_failure_envelope_for_fallback`
- `launch_requires_unknown_status_and_empty_agent_fields_for_fallback`
- `launch_correlates_returned_name_pane_and_agent_kind`
- `launch_applies_overrides_only_to_requested_primary`
- `launch_defaults_label_to_name`
- `launch_defaults_right_no_focus_and_current_cwd`
- `launch_can_create_new_tab`
- `launch_can_use_existing_exact_pane`
- `launch_uses_returned_pane_id_for_agent_start`
- `launch_wraps_initial_prompt_as_assignment`
- `launch_missing_caller_fails_before_mutation`
- `launch_optional_prompt_waits_for_ready_then_verifies_working`
- `launch_prompt_does_not_wait_for_completion`
- `launch_fresh_post_start_snapshot_join_precedes_dispatch`
- `launch_replacement_post_state_is_not_authoritative`
- `communicate_replacement_post_state_is_not_authoritative`
- `launch_prompt_acknowledgement_is_identity_bound`
- `launch_skipped_observation_does_not_duplicate_or_recover`
- `communicate_prompt_uses_atomic_ack_without_working_wait`
- `communicate_post_observation_is_optional_after_ack`
- `launch_success_never_closes_resources`
- `launch_partial_failure_preserves_created_resources`
- `launch_cancellation_preserves_truthful_partial_state`

`herdr_launch` accepts only a validated named Pi/Claude profile and typed
runtime overrides. Raw kind, argv, and env launch fields are rejected. Fallback
uses the real `cli:agent:start` error envelope and a schema-real pane proof; it
must never turn arbitrary strings into a shell command or retry an uncertain state.

### `pane.test.ts` / `herdr_pane`

- `pane_create_requires_label`
- `pane_create_defaults_right_and_no_focus`
- `pane_create_honors_explicit_down`
- `pane_create_honors_explicit_focus`
- `pane_create_uses_current_cwd_by_default`
- `pane_create_uses_returned_id_for_post_read`
- `pane_create_missing_label_fails_before_cli_mutation`
- `herdr_pane_has_no_close_or_cleanup_path`
- `public_pane_calls_never_issue_close`
- `pane_partial_failure_is_truthful`

### `tab.test.ts` / `herdr_tab`

- `tab_create_requires_label`
- `tab_create_defaults_no_focus`
- `tab_create_honors_explicit_focus`
- `tab_create_defaults_current_workspace`
- `tab_create_uses_returned_tab_id_for_post_read`
- `tab_create_missing_label_fails_before_cli_mutation`
- `herdr_tab_has_no_close_or_cleanup_path`
- `public_tab_calls_never_issue_close`
- `tab_creation_does_not_close_calling_pane`
- `tab_partial_failure_is_truthful`

### `ownership.test.ts`

Close validation is tested in a dedicated topology seam and through both
public pane/tab close tools. It is **not** exposed as an additional tool. Runtime
ownership remains bookkeeping for created resources, but never authorizes or
blocks an explicit exact close.

- `ownership_records_only_current_session_resources`
- `ownership_is_not_persisted_in_session_entries`
- `ownership_clears_on_reload`
- `ownership_clears_on_resume`
- `ownership_clears_on_new_session`
- `ownership_clears_on_session_change`
- `pane_close_unowned_without_ui`
- `tab_close_unowned_without_ui`
- `close_protects_caller_resources`
- `close_rejects_duplicate_cyclic_and_dangling_topology`
- `close_returns_operation_id_and_compact_post_state`
- `close_preserves_completed_mutation_after_abort`
- `close_reconciles_lost_response_when_absent`
- `close_uncertain_when_present_or_readback_fails`
- `public_pane_tab_calls_never_close_protected_resources`
- `session_shutdown_does_not_auto_cleanup`

Fixtures include sibling resources, transitive Herdr close effects, protected
caller ancestors, and malformed duplicate/cyclic/dangling topology. The
validation decision is based on fresh authoritative topology, not ownership.

### `results-rendering.test.ts`

- `results_include_structured_details_and_compact_text`
- `result_details_include_operation_target_ids_and_outcome`
- `partial_results_preserve_each_target_truth`
- `cancelled_results_include_latest_safe_snapshot`
- `timeout_results_include_latest_safe_snapshots`
- `render_call_is_compact_for_each_tool`
- `render_result_is_compact_when_collapsed`
- `render_result_expands_target_details_only_when_requested`
- `renderers_show_partial_timeout_cancel_and_error_states`
- `renderers_do_not_dump_raw_json_or_full_transcripts`
- `renderer_handles_missing_details_without_throwing`
- `renderer_handles_partial_update_without_claiming_completion`

Use deterministic fake themes and fixed widths. Assert rendered lines, collapsed
versus expanded behavior, and bounded transcript display rather than terminal
escape colors. Partial rendering must say that work is in progress or partial;
it must not display a success checkmark prematurely.

## Ordered red-green-refactor slices

Each slice follows the same loop: add the named tests, run them red, verify the
failure is the missing behavior, implement only enough to turn them green, then
refactor while all prior tests remain green.

1. **Standalone repository, settings, and test harness first.** Work from
   `/home/gabriel/.pi/agent/extensions/herdr-tools` as the standalone Git repo;
   establish its test runner, TypeScript build, lint, fake filesystem/settings
   loader, fake runner, fake reviewer, fake UI, fake clock, and fixture loader.
   Add all settings tests above plus registration/disabled-mode tests. No tool
   implementation exists when the first tests are written. Verify no test
   command resolves files from the Courier repository.
2. **Registration and runner contract.** Make the seven registration tests green;
   add signal propagation, JSON/error decoding, no-shell, and cancellation tests.
3. **Exact target resolution.** Add exact ID/current/unique-name resolution and
   fail-closed tests before any mutating tool is implemented.
4. **Inspect.** Implement single-target metadata plus exactly 100
   `recent-unwrapped` lines, compact collections, and health version/protocol.
   Confirm inspect has no mutation or focus path.
5. **Inter-agent provenance and communicate.** Implement the shared v1 envelope,
   authoritative sender resolution, self-target rejection, state-aware prompt/steer
   preconditions, direct steer submission without synthesized interrupt keys,
   authoritative working verification, envelope correlation, no completion wait,
   and no UI confirmation. Reuse the same envelope for launch initial assignments.
6. **Explicit turn control.** Add the strict cancel/interrupt schema variants and
   internal turn-control module. Bind each one-key dispatch to the snapshot plus
   fresh `agent get` identity, require `working`, wait only within the fixed 5,000
   ms window, always take an independent final snapshot, and prove either an
   advanced same-agent terminal state or the narrow interrupt agent-exited state.
   Cover abort, wait failure, disappearance, replacement, redaction, rendering,
   MCP parity/FIFO, and disposable-session evidence before topology work.
7. **Pane/tab creation.** Implement required labels, right/down direction,
   explicit focus, current cwd/workspace defaults, returned IDs, post-reads, and
   no implicit-close behavior.
8. **Close reliability.** Add current-session resource bookkeeping and lifecycle
   clearing, protected topology validation, sequential mutation registration,
   completed-mutation preservation, fresh post-readback, reconciliation, and
   typed uncertainty; keep caller resources protected and never retry a lost close.
9. **Launch.** Add known kind validation, unique name preflight, exact argv/env
   passing, default label/placement, new-tab/existing-pane choices, ready prompt,
   working verification, and no cleanup.
10. **Wait predicates and polling.** Add semantic/raw literal/raw regex
   conjunctions, single/multi target any/all, explicit bounded timeout, latest
   snapshots, authoritative polling, partial failures, and cancellation.
11. **Mandatory reviewer and config sampling.** Add extension-owned
    `config.json` defaults/validation and per-wait snapshot semantics, then add
    the one-per-target tool-less in-process reviewer, bounded deltas, concurrent
    uncapped fan-out, terminal findings, reviewer failure, and reviewer
    cancellation races.
12. **Results and renderers.** Add structured success/error/partial/timeout/
    cancelled details, compact call/result renderers, expansion, bounded output,
    and partial-progress behavior.
13. **Disposable integration.** Run the named Herdr session procedure below. Add
    only integration assertions not reliable with fakes; do not weaken unit tests.
14. **Final gates and bounded refactor.** Run the configured test, coverage,
    build, and lint commands. Stop after the agreed final review pass; record any
    remaining issue as a deviation/escalation rather than starting an endless
    review/fix loop.

Meaningful green slices may be committed as WIP according to the TDD skill. Never
commit a red test, broken build, or unreported deviation.

## Cancellation, timeout, and race matrix

The fake clock and runner must cover these deterministic orderings:

- abort before target resolution: zero CLI calls and no job registration;
- abort while a read is pending: runner sees the signal, polling stops, and no
  late observation is applied;
- abort while reviewers are behind a barrier: every reviewer sees abort and none
  can terminate the wait after cancellation;
- condition match immediately before deadline: match is returned;
- deadline before condition read completes: timeout with latest completed snapshot;
- condition and timeout in one scheduler turn: follow one documented precedence,
  test both sides, and never emit two settled wait results;
- reviewer terminal finding racing with condition match: exactly one settled
  `wait_result` is selected, with a snapshot and reason for the losing observation;
- cancellation between create/start and post-read: never claim a fully verified
  resource and never issue compensating close;
- prompt/steer post-read racing with state transition: report the observed state,
  not an optimistic working state;
- close command completing just before the initiating signal abort: fresh readback
  preserves completed mutation evidence;
- close response loss with absent/present/unavailable readback: reconcile only
  proven absence and otherwise return typed uncertainty;
- one target failing in a multi-target operation: preserve each target's
  evidence and failed-target error, without converting the whole wait to
  `condition_met`.

## Ownership and cleanup contract

Ownership is a memory-only safety ledger tied to the current Pi session. The
extension must clear it on `session_shutdown`/replacement and rebuild an empty
ledger on `session_start` for reload, resume, new session, or session change. It
must not use `pi.appendEntry`, a file, or an environment variable to preserve
ownership.

The current seven-tool public surface has no automatic cleanup and no cleanup tool.
Explicit `herdr_pane`/`herdr_tab` close is an autonomous mutation for an exact
non-caller target only after fresh protected-topology validation. It is serialized
with all other mutating calls. Lost or aborted close responses are reconciled once
from a fresh authoritative readback; target presence or readback failure returns
`MUTATION_UNCERTAIN` and never retries. For every close test, assert operation
order, completed-mutation preservation, compact sanitized post-state, caller
protection, and absence of modal UI access. Deferred admin/cleanup behavior
remains deferred.

For integration, assert current Courier IDs are absent from all teardown argv and
compare their pre/post snapshots.

## Disposable integration procedure

Integration is opt-in, serial, and never runs against the current Courier
workspace.

1. Verify `HERDR_ENV=1`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and
   `HERDR_PANE_ID` exist. Save a read-only snapshot of those current resources.
2. Create a unique disposable named Herdr session/workspace using the installed
   CLI's authoritative help syntax, with a disposable temporary cwd and a label
   such as `pi-herdr-tools-it-<run-id>`.
3. Parse every workspace/tab/pane ID from JSON responses. Assert the disposable
   workspace ID differs from `HERDR_WORKSPACE_ID`; never infer IDs.
4. Load the extension in a Pi integration process with the seven tools enabled.
   Assert registration count and that no deferred tool appears.
5. Exercise inspect health, compact collections, single-pane metadata/transcript,
   pane creation, tab creation, launch of a harmless supported kind, communicate,
   and bounded wait. Assert labels, direction, focus, cwd, status, transcript
   source, returned IDs, and post-read state.
6. Exercise timeout snapshots and the reviewer using a deterministic fake reviewer
   or a local configured reviewer adapter; do not require a paid network model.
7. On success or failure, teardown is test-harness code only. Close/delete only
   resources created by this named disposable integration session, after a final
   ownership/ID assertion. The product extension must issue no automatic cleanup.
8. Re-read current Courier workspace/tab/pane and compare protected fields with the
   initial snapshot. Fail if any current ID was mutated or appears in teardown.
9. If setup fails after creating resources, print the owned disposable IDs for
   manual recovery; never broaden cleanup to the current/focused workspace.

Integration must be skipped, not silently redirected, when Herdr is unavailable.
A skipped integration run is not a passing compatibility result; report it
separately from the unit gates.

## Build, lint, and coverage gates

This is a new standalone Git repository, so the first red slice must define its
package scripts and test configuration at
`/home/gabriel/.pi/agent/extensions/herdr-tools` before implementation. Do not
claim a configured gate until it exists, and do not inherit scripts or config from
Courier. The package must provide these commands (using the repository's existing
test tools when available):

```text
cd /home/gabriel/.pi/agent/extensions/herdr-tools
npm test                 # unit suite
npm run coverage         # unit suite with coverage and coverage summary
npm run build            # TypeScript type/build check
npm run lint             # lint all changed package source and tests
HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration # opt-in disposable Herdr integration suite
```

`npm run coverage` must enforce 100% statements, branches, functions, and lines
for every changed source file and print exactly `COVERAGE_RESULT: PASS` only when
those thresholds pass. Tests and fixtures may be excluded only when the coverage
configuration documents why they are not changed source. If no existing coverage
command can be reused, define the command and its configuration in the package's
first setup slice before implementation; do not invent a green result.

The final run order is:

```text
npm test
npm run coverage
npm run build
npm run lint
```

Record the actual command output and any deviation in the implementation report.
A passing test suite without `COVERAGE_RESULT: PASS`, clean build, and clean lint
is not done.

## Deterministic verification for untestable or environment-dependent items

Some properties cannot be completely proven by pure unit tests. Mark them
`UNTESTABLE` in the implementation report and attach the following deterministic
evidence rather than omitting them:

- **Pi global discovery and runtime registration — UNTESTABLE in unit tests:**
  launch Pi in print/JSON mode twice with `HERDR_ENV=1` and unset, inspect the
  registered tool metadata, and record exactly seven versus zero. Use a disposable
  Pi process, not the current session.
- **Installed Herdr CLI protocol/syntax — UNTESTABLE with static fixtures:**
  capture `herdr --help`/relevant group help and health output in the disposable
  integration session, parse version/protocol, and compare the runner's logical
  operation mapping. Never probe mutating commands by omitting arguments.
- **Actual renderer appearance — UNTESTABLE as a visual property:**
  use deterministic renderer snapshots at fixed widths/themes for call, result,
  expanded, partial, timeout, cancelled, and error states. A human visual check
  may supplement snapshots but cannot replace them.
- **Actual Luna provider availability — UNTESTABLE without a live model dependency:**
  resolve `luna/low` through an injected model registry/configuration adapter and
  verify no per-call override. A live paid call is not required for the unit gate.
- **Wall-clock review/timeout behavior — UNTESTABLE without slow tests:** use the
  fake monotonic clock for all unit assertions and, if needed, one bounded local
  smoke test. Never use real five-minute sleeps in the unit suite.
- **No current-Courier mutation — UNTESTABLE by fakes alone:** the integration
  procedure must snapshot current IDs before and after and inspect every mutation
  and teardown argv for those IDs.

Any implementation choice that contradicts an acceptance invariant is an
escalation, not a reason to rewrite this trace. The final implementation report
must include TDD-plan deviations, architecture deviations, scope deviations,
and concerns for the reviewer, as required by the source TDD skill.

## Approved automatic child-supervision amendment (summary)

Every successful `herdr_launch` creates a first-class `kind: "supervisor"` job.
The full amendment is at the end of this document.

## Approved detached wait-job amendment

The detached wait contract is now part of this plan. Add red/green coverage for
strict rejection of removed execution-mode fields, preflight-before-ID,
fresh-signal execution, frozen settings/target resolution, shared wait-runner
outcome mapping, and unused initiating progress callbacks. Every public
`herdr_wait` call must register a job and return immediately; wait progress is
stored on the job rather than streamed through the initiating call. Add registry tests for first-wins transitions,
newest-first filtered pagination, uncapped starts, latest-progress replacement,
immutable views, cancellation races, generation/shutdown staleness, and terminal
retention. Add `herdr_jobs` tool tests for strict list/get/cancel input, structured
`JOB_NOT_FOUND`, bounded output and renderers. Add runtime tests for exactly seven
registrations, active-branch completion pushes and their `deliverAs`/`triggerTurn`
options, manager-judgment priority, normal queue behavior, and cancellation or
shutdown suppression. Integration remains opt-in and must record the exact
blocker if unavailable; no test may weaken the 100% repository threshold.

## Approved active wait-visibility amendment

Add red/green schema tests for optional bounded printable single-line labels and
derivation tests covering state, literal-output, regex-output, resolved display
names, and multiple targets. Detached call rows must show supplied labels, and
detached acknowledgements and job rows must show the effective post-preflight
label. Registry/tool projections preserve it or explicitly mark aggregate
compaction through bounded detail/list forms.

Add a deterministic UI-controller suite with fake clock/timers and fake Pi UI.
Cover zero-to-one and one-to-zero timer transitions, one-second spinner/elapsed
refresh, exact active count and oldest elapsed calculation, Pi-compatible 10-line
active widget output with a reserved omission row, label/time/ID rows, toggle-on/toggle-off,
session-scoped toggle memory across an empty active set, and full session cleanup.
Rendering failures must not affect job state. Registration tests must verify the
`/herdr-waits` read-only command, unchanged seven-tool registration, no factory
background timer, and non-UI behavior. Existing terminal notification and
`herdr_jobs` cancellation coverage remains authoritative.

## Approved automatic child-supervision amendment

Automatic child supervision is part of this plan. It is observation and
notification only, and every test below holds the repository's enforced 100%
threshold; no test may weaken it.

**Protocol validation.** Cover the fixed global subscription set and prove it
excludes `pane.agent_status_changed`, which requires a `pane_id` and therefore
cannot serve children that do not exist yet. Cover reply, failure, accepted
event, and ignored-kind parsing, and prove every malformed line is refused rather
than skipped: non-JSON, non-object, unusable identifier, a reply with neither
result nor error, a malformed error body, a line that is neither reply nor event,
malformed event data, and an oversized frame. Cover `PaneInfo` validation for
every field protocol 22 requires, for optional fields supplied as `null`, and for
each malformed shape. Cover the subscription acknowledgement requirement.

**Socket.** Cover request correlation by id, ignored unknown ids, server failures,
request timeouts that leave the connection usable, lines reassembled across chunks
without splitting a code point, skipped blank framing lines, refusal of an event
that arrives before the acknowledgement, connection teardown on a malformed or
oversized line, peer close, idempotent close, and a real unix-socket round trip
through the `node:net` seam plus its unopenable and connect-bound paths.

**Identity.** Cover whole-identity comparison including all four agent-session
components, the `continuous`/`unproven`/`replaced` verdicts, agent-name checking
only where a snapshot supplies one, and move continuity: proven, unproven session,
wrong pane, replaced occupant, and a revision that went backwards.

**Monitor.** Cover snapshot-then-subscribe bootstrap shared by concurrent callers,
refusal without a socket path and after shutdown, closure on an unacknowledged
subscription, fan-out by pane id including a move's previous pane id, lossless
reconnect with one degraded episode and one recovery, a silent immediate
reconnect, only-first-failure degradation reporting, and no reconnect after stop.

**Supervisor.** Cover binding to the proven occupant with a revision anchor, with
and without a `state_change_seq`; refusal to bind on an unreadable snapshot, a
non-unique occupant, or a replaced identity; queued events during binding;
historical replay below the anchor ignored; a working start recorded silently; a
completed work cycle and a block waking; thin and unprovable events reconciling
rather than concluding; reconciliation unavailability keeping supervision active;
coalesced concurrent reconciliations; proven and unproven moves; silent reconnect
versus one high-priority `evidence_gap`; replay dedupe across a reconnect;
identity lost on reconnect; monitor degradation and recovery; the review cadence
storing progress silently, waking on attention, degrading once and recovering
once, treating an unreadable transcript as a reviewer failure, refusing to review
a non-working or settled child, refusing concurrent reviews, and not re-arming for
a child that stopped working mid-review; soft receipts returned once; settlement
on shutdown, on a released reservation, and never twice.

**Reviewer and model service.** Cover the exact pinned model and `max` thinking,
credentials omitted when the service supplies none, prompt bounding, abort before
and during the call, malformed and non-JSON responses, transport failures
including a non-`Error` rejection, the Pi registry adapter, the host-independent
built-in catalogue service, and identifier validation. Cover that only
`stalled`/`blocked`/`risk`/`appears_complete`/`unknown` wake the manager.

**Job registry.** Cover the discriminated request union, `kind` on details and
summaries, supervisor settlement into `supervision_result`/`supervision_reason`,
the `kind` list filter, `attachSupervision` refusals, the bounded supervision
projection with its truncation counters and field clipping, evidence dropped
before the job in a compact projection, the minimal projection keeping the
supervisor outcome and unobserved count, cancellation refusal while a child is
live, and unconditional shutdown.

**Launch.** Cover reservation before any topology mutation, binding after prompt
confirmation, the returned job ID in content and details, supervision of a launch
with no `initialPrompt` and of an existing-pane launch, `SUPERVISION_UNAVAILABLE`
with no dispatched mutation, `SUPERVISION_UNCONFIRMED` as a partial effect with
child evidence and no cleanup, an untyped reserve failure classified rather than
echoed, a non-binding failure rethrown unchanged, and reservation release on any
failure after reserving.

**Notification and hosts.** Cover bounded wake content and meta, the Pi steer
options, the Claude Channel method and capability, swallowed delivery failures on
both paths, and an inert notifier. Cover both host wirings end to end against a
real unix socket: the Pi runtime reserving, binding, and waking by steer, and the
MCP server advertising `claude/channel`, resolving its own model service, and
waking by channel notification.

**Profile.** Cover tagged-only `runtime.developmentChannels` entries, the emitted
`--dangerously-load-development-channels` argv, and the unchanged capability
matrix for every other bundled profile.

Existing explicit-wait behaviour, its reviewer at Luna `low`, and existing
`herdr_jobs` coverage remain authoritative and unchanged.

### Review-round remediation coverage

The first review round added these required regressions, all inside the enforced 100%
threshold:

- a Pi session that follows a shutdown reserves successfully, and the replaced monitor stays
  stopped;
- a subscription acknowledgement and the first replay event delivered in one socket chunk are
  accepted atomically, and a wrong acknowledgement in the same chunk still rejects and closes;
- a subscription whose socket died before adoption is refused;
- events reach observers strictly in stream order even when one suspends on a snapshot, and
  an observer that throws does not break the chain;
- every malformed known lifecycle event is refused at the protocol boundary rather than
  routed nowhere;
- consecutive reviews receive only the newly produced transcript lines;
- a review whose work cycle ends during the transcript read or the model call is abandoned,
  with nothing stored, nothing announced, and no advanced transcript cursor;
- a fallback-selected profile is bound and published, with the reserved profile kept beside it
  only when the two differ;
- the reviewer prompt bound holds for multibyte output and never splits a code point.

### Second review-round remediation coverage

The second round replaced ordinal-based deduplication with the pane revision and added these
required regressions, all inside the same enforced 100% threshold:

- events delivered inside the acknowledgement's own chunk still reach observers, so the
  monitor's handlers must be installed before `events.subscribe` is issued;
- a monitor stopped while a bootstrap is awaiting refuses to adopt that connection, adopts no
  generation, and shares the abandoned attempt with nobody;
- an event and a reconnect bootstrap reach every matching observer even when an earlier
  observer fails on routing, folding, bootstrap, degradation, or recovery, including a failure
  thrown before the first await;
- replay deduplication holds across a proven pane move and the replayed move is discarded on
  its own revision without costing a snapshot;
- a move that arrived while binding advances the same watermark, so its replay cannot settle a
  live supervisor `identity_lost`;
- a move whose previous pane is not this supervisor's, or whose record does not prove this
  occupant, reconciles: it stays active where authoritative state proves the child, and
  settles `identity_replaced` only where that state proves the loss;
- a reconnect whose outage transitions have scrolled out of the retained log adopts the
  snapshot's status and revision alongside the `evidence_gap`, and does not refold below it;
- a reviewer rejection belonging to a finished work cycle degrades nothing, wakes nobody, and
  re-arms nothing, while a cadence firing during an obsolete review re-arms for the live run
  and a cadence firing after the child left `working` re-arms nothing;
- binding re-points the supervisor job's request as well as the supervision view at the
  profile and kind that actually started the child, and `bindSupervisionChild` refuses an
  unknown job and a non-supervisor job.
