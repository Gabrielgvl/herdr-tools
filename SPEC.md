# Specification: Herdr Tools Pi Extension

**Status:** Approved contract; implementation in progress.

## Objective

Create a global Pi extension in `/home/gabriel/.pi/agent/extensions/herdr-tools/` that gives a Herdr-managed Pi agent a small, explicit tool surface for inspecting and coordinating Herdr panes, agents, tabs, and topology.

The extension is available only inside a Herdr pane (`HERDR_ENV=1`). It uses the installed `herdr` CLI through `pi.exec` as the sole Herdr authority. It must target explicit stable IDs or the caller's explicit current context, fail closed on unresolved targets, and return authoritative post-operation state.

The core user is an agent operating inside Herdr. Success means the agent can safely inspect, communicate with, wait for, launch, and arrange Herdr resources without guessing IDs, silently targeting a focused pane, mutating managed Pi integration state, or hiding failures.

## Scope and authoritative decisions

The core release registers exactly these seven custom tools and no others:

1. `herdr_inspect`
2. `herdr_communicate`
3. `herdr_wait`
4. `herdr_jobs`
5. `herdr_launch`
6. `herdr_pane`
7. `herdr_tab`

The following are explicitly deferred and must not be registered, aliased, or implemented as hidden behavior:

- `herdr_command`
- `herdr_workspace`
- `herdr_admin`

Raw Herdr Bash remains available exactly as it is. The extension must not intercept, rewrite, prioritize, or prohibit raw Herdr Bash usage in favor of these tools, and must not register `tool_call`, `user_bash`, or input-routing handlers for that purpose.

The extension must not edit `/home/gabriel/.pi/agent/extensions/herdr-agent-state.ts`. That file is installed and managed by Herdr. The existing `herdr-question-alert.ts` integration remains separate and unchanged.

## Architecture

### Extension boundary

- The entry point is a global Pi extension discovered from the `herdr-tools` directory beside the existing global extensions.
- The extension factory checks `process.env.HERDR_ENV` before registering anything.
- When `HERDR_ENV !== "1"`, the factory registers no tools, starts no timers, opens no sockets, makes no CLI calls, and creates no background resources.
- When enabled, the factory registers only the seven core tools. Registration uses Pi's custom-tool API and strict schemas. There are no compatibility aliases or deprecated input fields.
- Tool calls use Pi's `execute` contract, including `AbortSignal`, `onUpdate`, structured `details`, and compact custom call/result renderers.

### CLI adapter

All Herdr *operations* go through `pi.exec("herdr", argv, options)` with an argument array. The extension must not invoke a shell string, reimplement the Herdr protocol, or synthesize Herdr identifiers.

The one exception is automatic child supervision, which observes the local Herdr socket read-only. Supervision issues exactly `session.snapshot` and one `events.subscribe` per connection over newline-delimited JSON at `HERDR_SOCKET_PATH`, validates every value the server sends against the installed `herdr api schema`, and never mutates anything. Every mutation, and every operation of the seven tools, still goes through the CLI. See `docs/specs/auto-child-supervision.md` and ADR-019.

The installed CLI is authoritative for command syntax, supported agent kinds, response shape, and client/server compatibility. The adapter must:

- pass the active `AbortSignal` to every CLI call;
- use bounded command timeouts;
- capture exit code, stdout, and stderr;
- parse JSON only where the CLI returns JSON and preserve authoritative fields without inventing replacements;
- treat malformed or incompatible output as a protocol/compatibility failure;
- use `--current` only when the operation explicitly targets the caller's current pane/context;
- pass returned opaque IDs to subsequent commands rather than constructing IDs from workspace, tab, pane, or display numbers;
- re-read authoritative state after every mutation.

Read-only discovery may use the installed command groups shown by `herdr --help`, including `herdr status`, `herdr api snapshot`, `herdr api schema --json`, and the relevant `pane`, `agent`, and `tab` commands. No update, server stop, workspace mutation, or admin operation is in scope.

Herdr 0.8 does not expose conditional compare-and-send or compare-and-close flags. Adapter-side preflight and post-state verification therefore provide bounded fail-closed behavior but cannot make the check-and-mutation atomic. The residual atomicity gap is an upstream Herdr limitation and remains visible rather than being hidden by compatibility shims.

### Target resolver

`TargetRef` is a non-empty string supplied by the caller. Resolution is exact and fail-closed:

1. `current` means the calling context, never the UI-focused pane.
2. An exact stable Herdr ID is accepted as an opaque value.
3. An exact pane label is accepted for pane-capable operations.
4. An exact agent name is accepted only when it identifies one agent.
5. Missing matches produce `TARGET_NOT_FOUND`.
6. Multiple exact matches produce `TARGET_AMBIGUOUS`.
7. A resolved resource of the wrong kind produces `TARGET_TYPE_MISMATCH`.
8. No fuzzy matching, prefix matching, substring matching, display-number inference, or sidebar-order inference is permitted.

For pane/agent operations, an exact pane label or unique agent name is resolved to an authoritative pane/agent record before mutation. For tab operations, stable tab IDs and `current` are accepted; tab labels are not silently treated as pane labels. Collection inspection is scoped to the current Herdr context and uses authoritative collection results.

The caller's injected IDs (`HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID`) are required syntactic bootstrap identity, not an immutable topology snapshot. Every context-dependent operation reads `herdr pane current --current`, using the injected pane identity as the selection anchor, then verifies the returned effective pane against one authoritative `api snapshot`. Herdr may return a new public pane ID for an old pane alias. When that happens, both records must carry the same terminal identity. The live tab and workspace become the effective context, so a pane move can rebind stale ancestors. A small bounded retry may handle a concurrent move. Missing, malformed, unresolved, duplicate, incoherent, replaced, or persistently racing identity fails closed. Health reports the injected presence and validity flags and does not call stale ancestor IDs malformed.

## Common schemas and result rules

The following are reviewable contracts, not implementation code.

### Common scalar types

- `TargetRef`: non-empty string; exact stable ID, `current`, exact pane label, or unique agent name as permitted by the operation.
- `Direction`: one of `right`, `down`, `left`, `up`.
- `AgentState`: raw Herdr state `idle`, `working`, `blocked`, `done`, or `unknown`.
- `SemanticState`: `started`, `completed`, `needs_input`, or `terminal`. `completed` is an input predicate only; it is not a job result alias.
- `NamedKey`: one token from the installed Herdr CLI's supported named-key vocabulary. Raw bytes, escape sequences, control-character strings, and arbitrary text are invalid. Unknown key names fail before CLI mutation.
- `EnvMap`: a string-to-string map. Environment variable names are not restricted by an extension allowlist; only values that cannot be represented by the CLI transport are rejected.

Schemas are strict: unknown top-level fields and invalid discriminant combinations are rejected. Strings containing NUL or newline where the target/label/name is a single identifier are invalid.

### Result envelope

Every successful tool result contains:

- concise human-readable `content` text;
- structured `details` containing the operation, resolved target/resource IDs, authoritative result, and warnings if applicable;
- no unbounded CLI transcript or raw stderr.

Mutation results include authoritative post-state when the operation has one. For `herdr_communicate` prompt/steer, the typed submission acknowledgement is the atomic mutation evidence and the follow-up read is optional diagnostic observation. Launch initial-prompt success additionally requires bounded semantic consumption confirmation after that acknowledgement. A post-state and success-row state are retained only after the full captured pane/terminal/name/kind/agent_session identity matches; a replacement is omitted from authoritative fields and, for launch, fails closed as `PROMPT_UNCONFIRMED`. That cause means consumption was not proven but the acknowledged prompt was possibly consumed; callers must preserve effect evidence and must not retry or continue dependent work. For a closed resource, the post-state is the authoritative containing context and a list of removed IDs, because the closed resource can no longer be read. Tool renderers show a compact row by default and may show structured details when expanded.

Expected domain failures are represented by a stable error code, concise summary, and structured error details. The tool must signal execution failure through Pi's error mechanism rather than returning a success-shaped result with an error-looking sentence.

## Tool contracts

### `herdr_inspect`

**Purpose:** Read current context, one exact target, a compact collection, or Herdr health. This tool never mutates.

**Input:**

```text
{
  mode?: "context" | "target" | "collection" | "health",  // default: "context"
  target?: TargetRef,                                      // required for target mode
  collection?: "panes" | "agents" | "tabs"                    // required for collection mode
}
```

Rules:

- `context` is the default, resolves the caller's current pane/context through the shared live context resolver, and uses the same single-target payload: authoritative metadata plus at most the 100 most recent unwrapped output lines, in order. Its structured details visibly include injected IDs, effective IDs, and whether rebinding occurred.
- `target` reads exactly one resolved pane/agent target and returns authoritative metadata plus at most the 100 most recent unwrapped output lines, in order. The line cap is fixed and cannot be overridden by the tool call.
- `collection` returns compact metadata only for the requested current-context collection. It does not include pane transcripts, full process output, or a per-item 100-line payload.
- `health` returns environment presence, client status/version, server status/version, socket reachability as available, and an explicit client/server compatibility result. Secret values and full socket paths are not exposed; presence and safe diagnostic labels are sufficient.
- Invalid combinations, such as a target in health mode or a missing collection in collection mode, fail before the CLI mutation/read sequence.

**Structured result:** `kind`, normalized current/target/collection metadata, authoritative raw metadata fields where needed for forward compatibility, and for a single target `recentUnwrappedLines` capped at 100. Collection entries contain only compact IDs, parent IDs, labels, agent names, and states available from the authoritative response.

### Inter-agent message provenance

Every cross-pane text delivery made by `herdr_communicate` (`prompt` or `steer`) and every `herdr_launch.initialPrompt` is wrapped in this mandatory recipient-visible envelope:

```text
[HERDR AGENT MESSAGE v1]
from: coordinator (w1:p1)
kind: steer
authority: agent; not user/owner
payload: all text after this blank line is sender-authored

<caller-supplied payload>
```

The extension generates the complete header; callers supply only the payload and cannot override or suppress provenance or authority. `kind` is `assignment` for launch initial prompts and preserves `prompt` or `steer` for communication. Sender display identity is resolved from the fresh authoritative snapshot in this order: explicit agent name, pane label, agent kind, then the stable pane ID alone. The pane ID is always included. If the caller pane is absent from the fresh snapshot, delivery fails with `SENDER_IDENTITY_UNAVAILABLE` before sending text. `herdr_communicate` rejects a target whose pane ID equals the caller pane ID with `SELF_TARGET_REJECTED`.

The first-line sentinel and version are stable protocol. All metadata values are normalized to one line so they cannot inject fields; the original payload is preserved after the single separating blank line. This is clear cooperative provenance, not cryptographic authentication: ordinary terminal or raw Herdr CLI/API input can imitate the text, and those paths are outside this extension's guarantee. Named-key delivery is control input, not a message, and is never wrapped.

### `herdr_communicate`

**Execution:** This mutating tool is registered with `executionMode: "sequential"` so communication and turn-control calls cannot overlap.

**Purpose:** Send a normal prompt, explicitly steer an agent, send named keys, request safe cancellation, or request a stronger interruption. Prompt, steer, and keys operations do not wait for turn completion; cancel and interrupt perform bounded authoritative settlement confirmation.

**Input:** exactly one of these operation shapes:

```text
{ target: TargetRef, operation: "prompt",    text: string }
{ target: TargetRef, operation: "steer",     text: string }
{ target: TargetRef, operation: "keys",      keys: NamedKey[] }
{ target: TargetRef, operation: "cancel" }
{ target: TargetRef, operation: "interrupt" }
```

Rules:

- Every operation reads and classifies the authoritative pre-state before sending bytes. `unknown` or malformed state returns a typed no-send error.
- `prompt` and `steer` resolve the authoritative sender from the same fresh snapshot used for target resolution, reject self-targeting, and send the mandatory v1 inter-agent envelope. There is no raw-text or provenance opt-out.
- `prompt` refuses to interrupt `working` targets and fails with `TARGET_BUSY`; idle, done, and blocked targets receive one direct `agent prompt --stdin` submission.
- `steer` never sends Escape or any other interrupt key. For idle, working, done, or blocked targets it submits the text directly through Herdr's `agent prompt --stdin` path; when the agent is working, its own TUI receives that submitted prompt as steering input. Prompt and steer use no Herdr `--wait` flags because the CLI's optional working-state observation can report `agent_prompt_stalled` after accepting the text, especially when screen detection is skipped. Unknown or malformed state is a typed no-send failure.
- Before every text submission, the extension joins the fresh snapshot agent record with fresh `agent get` and pane evidence. Communication has no start record, so this fresh join must establish the exact pane ID, terminal ID, agent name, agent kind, and complete `agent_session` `{source,agent,kind,value}`; every supplied field must agree, and missing/null fields are not fabricated. Missing, malformed, or contradictory identity fails closed before stdin is opened; a pane/name/kind match alone is never sufficient.
- A parsed `cli:agent:prompt` / `agent_prompted` envelope with that exact captured identity and `interactive_ready:true` is the atomic submission acknowledgement. It confirms that Herdr accepted the wrapped bytes, not that the agent started or completed a turn. A malformed, mismatched, or failed acknowledgement is terminal; the extension never resubmits or presses Enter.
- `keys` remains the lower-level named-key escape hatch. The existing allowlist includes `esc`, `escape`, and `ctrl+c`; those keys dispatch directly and do not claim cancel/interrupt's verified semantic or causal contract. Generic keys are not rerouted through turn control.
- After text submission, fresh agent and pane reads form an optional identity-bound observation. Details retain the acknowledgement plus an observation status of `working`, `not_working`, `unknown`, `stale`, or `unavailable`; a missing or replaced post identity omits `postState` and success-row state and may retain only bounded mismatch evidence in the observation. `screen_detection_skipped` remains a diagnostic boolean and never changes classification or downgrades the confirmed submission. No communication operation waits for semantic consumption or completion.
- Legacy communication details retain envelope IDs for snapshot, identity, prompt/key, and post-state calls. Turn-control details retain every backend operation ID only after bounding it to the model-visible evidence limit. Details include bounded pre/post state, bounded captured identity-bound submission evidence, observation evidence, and route (`prompt_direct` or `steer_direct`). Named-key dispatch remains lower-level and does not become a semantic turn acknowledgement.

#### Explicit turn control

The public `herdr_communicate` union also accepts exactly these strict variants:

```text
{ target: TargetRef, operation: "cancel" }
{ target: TargetRef, operation: "interrupt" }
```

These variants have no text, keys, delivery, or other fields. Prompt, steer, and named-key behavior is unchanged. Turn-control calls remain sequential in both Pi and MCP hosts.

Turn control is fail-closed and only applies to an authoritative `working` target. After exact snapshot resolution, the extension requires exactly one target pane record and exactly one target agent record, then performs one fresh `herdr agent get` against the resolved pane ID. The records are strictly joined: repeated pane/terminal/name/kind/session/state/parent evidence must agree, with no object-spread overwrite. The snapshot and `agent get` must report the same `working` agent, and the fresh `agent get` must carry its own non-empty `pane_id`; the extension never fills that required field from the earlier snapshot. Missing records or identity is `TARGET_IDENTITY_UNAVAILABLE`; a changed or contradictory identity is `TARGET_IDENTITY_CHANGED`; a non-working target is `TURN_NOT_ACTIVE`; existing unknown or malformed state errors remain typed and no key is sent.

`cancel` sends exactly one named `esc`. `interrupt` sends exactly one named `ctrl+c`. Neither operation retries, escalates, falls back, focuses a pane, or sends any other key. Each then waits at most the fixed 5,000 ms window for `idle`, `blocked`, `done`, or `unknown`. The final verification is always an independent fresh `api snapshot`, even when the wait fails or the caller aborts after dispatch. Same-agent confirmation requires the original pane/terminal/session identity, a terminal state of `idle`, `blocked`, or `done`, and a strictly advanced `state_change_seq`. When both pre-dispatch reads provide a sequence, fresh `agent get` evidence must not regress below the snapshot baseline; a regressed read is rejected before dispatch, and confirmation binds to the freshest non-regressed sequence. Cancel never treats disappearance as success and returns `CANCEL_UNCONFIRMED` instead. Interrupt may return `agent_exited` only when the dispatch response was acknowledged and the final snapshot proves there is exactly one target-pane record, zero target-agent records, the exact pane and terminal remain under the original tab/workspace, the pane is agent-free `unknown`, and the captured session identity is absent everywhere else. Duplicate target-pane or target-agent records are rejected before the global absence proof. The absence scan covers every recognized session representation on every pane and agent record, including structured and legacy `agent_session`, `agent_session_id`, `session_id`, and two independent flattened alias families (`agent_session_*` and `session_*`); a partial family, matching, malformed, or contradictory evidence fails closed, and fields are never merged across families. The reported reason is `post_dispatch_absence_proven`; it never claims that the key directly caused the exit. Otherwise the operation returns `INTERRUPT_UNCONFIRMED` or the appropriate stable identity/state error.

Abort before key dispatch is `ABORTED`. After dispatch, the dispatch evidence is retained and wait/final verification use independent bounded signals, so a caller abort cannot erase mutation evidence or produce an unverified success. Details for both success and post-dispatch failure include bounded pre/final evidence, phase, reason, dispatch acknowledgement/attempt, operation IDs, control key/window, wait evidence, and the confirmation kind. Compact renderers show only the operation outcome, target ID, and final state; they do not expand this into raw CLI output.

### `herdr_wait`

**Purpose:** The MCP `herdr_wait` tool waits for one or many exact agent/pane targets to satisfy a state or output condition. It is distinct from the CLI `herdr agent wait` readiness command; output conditions use authoritative pane reads, not a CLI `herdr wait` command.

**Input:**

```text
{
  targets: TargetRef[],
  match: "any" | "all",
  condition:
    { kind: "state", state: AgentState | SemanticState }
    | { kind: "output", match: { kind: "literal" | "regex", value: string } },
  timeoutMs: integer,          // required, 1 through 3,600,000 inclusive
  label?: string               // optional single-line display label
}
```

Rules:

- `targets` has at least one item. Duplicate target references that resolve to the same resource are rejected.
- `match: any` is satisfied when one target matches the condition; `match: all` is satisfied when every target matches it.
- Raw states are `idle`, `working`, `blocked`, `done`, and `unknown`.
- Semantic `started` matches `working`; semantic `completed` matches `idle` or `done`; `needs_input` matches `blocked`; `terminal` matches `idle`, `blocked`, or `done`. These are input predicates only: `completed` is not a job result name.
- Output conditions search the target's recent unwrapped output through the installed CLI. Literal and regex are mutually exclusive. Invalid regex syntax is a structured input failure. Existing output is eligible, so a condition already satisfied is observed immediately.
- A wait always returns a detached acknowledgement. Its operation phase is `accepted`, and its opaque job ID is the handle for later inspection. A timeout is a terminal `wait_result: "timed_out"` with `matched: false`, `reason: "timeout"`, and bounded latest snapshots; it is not a whole-call exception.
- An abort during validation or target/context preflight is distinct from a timeout and ends the tool call with `ABORTED`. Once registration succeeds, the initiating signal and update callback are no longer used; inspect or cancel the job through `herdr_jobs`.

#### Long-wait review supervision

A wait whose timeout is longer than the configured review cadence is a long wait. This threshold is an explicit implementation assumption because the product decision specifies cadence but not a separate threshold.

Long waits use mandatory in-process, tool-less reviewer calls:

- The reviewer model is the extension-owned setting from `config.json`, default `openai-codex/gpt-5.6-luna`; the tool cannot select or override it.
- Reviewer thinking is fixed at `low`; the tool cannot select or override it.
- At every review interval, one independent reviewer call is made per target, all concurrently, with no target-count cap. Native lifecycle waits are bounded into review windows so this supervision is not bypassed by one long native command.
- Reviewer calls are not Herdr panes, are invisible in Herdr topology, receive no tools, and cannot mutate or communicate.
- Each reviewer receives only bounded transcript deltas since the previous review plus compact authoritative metadata. The bounded transcript input is at most the same 100 recent unwrapped lines used by single-target inspection; unchanged lines must not be resent when a smaller delta is available.
- A reviewer may summarize/classify only `progress`, `stalled`, `blocked`, `risk`, `appears_complete`, or `unknown` and may provide a bounded summary. `appears_complete` is advisory and never satisfies the wait predicate.
- A reviewer result requiring manager judgment ends the job early with `matched: false`, `wait_result: "manager_judgment_required"`, `reason: "manager_judgment_required"`, final snapshots, and reviewer summaries.
- Reviewer/model failure ends the job immediately with terminal `wait_result: "failed"` and `REVIEWER_FAILED`; there is no fallback model, pane, or silent continuation.
- Reviewer summaries appear in detached job progress and final `herdr_jobs` details. The reviewer never changes the authoritative wait condition: only the native Herdr predicate or composite output observation can satisfy it.

### Detached wait jobs and `herdr_jobs`

`herdr_wait` has no execution-mode field. Its schema is strict: every unknown field is rejected. Every call performs parameter validation, extension-owned settings loading, live caller-context resolution, exact target resolution, identity/generation capture where required, and duplicate resolved-resource rejection before registering anything. These preflight steps use the initiating tool signal and throw directly on failure without creating a job.

After preflight, the extension always registers a stable opaque `job_${randomUUID()}` identifier and runs the prepared wait engine under a fresh per-job `AbortController`. The prepared parameters, settings, resolved IDs, and opaque target-generation references are copied at registration. Timeout starts after registration. The initiating signal, call-scoped update callback, and synchronous result path are never used by post-registration work. A session generation check prevents stale preflight from registering into a replacement session. The tool returns the detached acknowledgement immediately; all later operation phases, terminal `wait_result` values, progress, reviewer evidence, and cancellation evidence are read through `herdr_jobs`.

The registry holds two job kinds. A `kind: "wait"` job is the detached wait described here. A `kind: "supervisor"` job is created automatically by every successful `herdr_launch` and watches that exact child for its whole life; it is described in "Automatic child supervision" below. Both kinds are listed, inspected, and shut down through `herdr_jobs`, and there is no eighth public tool.

The in-memory, session-wide registry has no concurrency cap and retains terminal jobs until shutdown. Its public operation phases are exactly `accepted`, `running`, `cancel_requested`, and `settled`. `wait_result` is absent before `settled` and, at settlement, is exactly one of `condition_met`, `timed_out`, `manager_judgment_required`, `failed`, `cancelled`, or `unknown`. Terminal transitions are first-wins, and only latest bounded progress is stored. `herdr_jobs` is the sole public registry view and is strict:

- `{operation:"list", operation_phase?, kind?, offset?, limit?}` filters by operation phase and optionally by job kind, orders newest-first by insertion sequence, filters before pagination, defaults offset to `0` and limit to `20`, caps limit at `100`, and returns `{total,nextOffset,jobs}` with transcript-free summaries.
- `{operation:"get", jobId}` returns a bounded, typed full current or settled detail for an owned job. For a supervisor it also returns the pending unobserved supervision events and marks exactly the events it returned observed. A settled target observation carries structured `target_evidence` with its kind, observation timestamp, opaque target-generation reference, `currency: "historical_non_current"`, and evidence source; it is never current target truth.
- `{operation:"cancel", jobId}` is refused with `SUPERVISION_ACTIVE` for a supervisor whose exact child is still live. Otherwise it closes the operation gate and advances its fence before publishing `cancel_requested` or aborting the runner. It waits for bounded runner/command/callback quiescence: only observed drain settles `wait_result: "cancelled"`; uncertainty settles `wait_result: "unknown"` with `CANCELLATION_UNCERTAIN`. A settled job is returned unchanged, and unknown IDs are structured `JOB_NOT_FOUND`.

On session shutdown, notification delivery is disabled first, running jobs are fenced and aborted, in-memory jobs are discarded, and registry ownership/generation is reset. `/tree` does not cancel jobs. Terminal notifications are one-shot, visible, best-effort Pi messages; they make no delivery or consumption claim. Explicit cancellation and shutdown cancellation never notify. Manager-judgment notifications start with `HIGH PRIORITY: MANAGER JUDGMENT REQUIRED` and use details priority `high`; every other terminal notice uses normal priority. Notification text and details identify the job ID, operation phase, terminal wait result when present, reason, requested/matched targets, and only bounded evidence kinds or error summaries, treating pane/output text as untrusted data.

All model-visible content, list summaries, terminal notifications, and renderers enforce Pi's 50KB/2,000-line bounds with explicit truncation and no full transcripts. No background resource starts in the extension factory; only tool execution registers jobs.

#### Active wait visibility

`label` is valid for every detached wait. A supplied label is a bounded non-empty printable single-line value. When omitted, preflight derives one bounded effective label from resolved target names plus the requested state/output condition (for example, `worker-pi +2 → completed`). A supplied label appears in the call row and detached acknowledgement. An omitted label cannot be derived until asynchronous target preflight finishes, so it appears in the acknowledgement rather than the already-rendered call row. Detached jobs store the effective label in request details and list summaries, so `herdr_jobs` and the TUI expose the same identity unless an aggregate projection explicitly marks the label truncated; duplicate labels are allowed because exact actions continue to use `jobId`.

While detached jobs are active, the extension owns one session-scoped Pi footer status. It renders an animated spinner, the exact active count, the elapsed time of the oldest active job, and the `/herdr-waits` hint, refreshing once per second. The timer starts only when an active job exists and stops immediately when none remain. Status/UI failures never alter registry state.

`/herdr-waits` is a read-only toggle for an above-editor active-job widget. Each visible row contains the effective label, current elapsed time, and exact job ID. Pi bounds string-array widgets to 10 lines, so the extension uses at most 10 total lines and reserves the final line for an omission count when more jobs are active. It clears while the active set is empty but remembers the enabled preference for the current session, so a later wait restores it automatically. A session transition clears footer/widget state, stops the timer, and resets the toggle. Inspect and cancel remain `herdr_jobs` operations; terminal notifications remain unchanged.


### Automatic child supervision

Every successful `herdr_launch` creates a live supervisor for the exact child it launched, including a launch with no `initialPrompt` and a launch into an existing pane. Supervision is observation and notification only: it never mutates the child, never gates its work, and never becomes a public tool.

**Reserve, then bind.** `herdr_launch` reserves supervision before its first topology mutation, in phase `supervision_reserve`; a failure there refuses the launch with `SUPERVISION_UNAVAILABLE` and `effectCertainty: "absent"`. It binds in phase `supervision_bind`, after readiness has proven the exact launch identity and, when a prompt was sent, after prompt consumption is confirmed. A binding that cannot be proven throws `SUPERVISION_UNCONFIRMED` as a partial-effect failure carrying child evidence, with no retry and no cleanup of the child. Profile fallback stays strictly inside `agent_start`, before assignment and before binding. A launch that fails between reserve and bind releases its reservation so the job settles; releasing a reservation is never child cleanup. A successful launch returns the stable supervisor job ID in both its model-visible content and its details.

**One session connection.** Supervision opens one connection to `HERDR_SOCKET_PATH` for the whole manager session and multiplexes it across every supervisor. Bootstrap is always `session.snapshot` first and one acknowledged `events.subscribe` second. The subscription set is fixed — `pane.created`, `pane.updated`, `pane.closed`, `pane.exited`, `pane.moved`, `pane.agent_detected` — because Herdr 0.8.2 drops a connection that subscribes twice, which also rules out per-pane `pane.agent_status_changed`. `pane.updated` carries a full `PaneInfo`, so it is the authoritative status channel.

**Identity and anchoring.** A supervisor pins `pane_id`, `terminal_id`, the agent name and kind, and the whole four-part `agent_session`, and anchors on the pane `revision` its bind snapshot observed. Pane IDs are reused across the durable event log, so a thin event carrying only a pane ID is a reconciliation trigger — a fresh `session.snapshot` decides — never a conclusion. A pane move is followed only when an atomic move event and a fresh authoritative occupant both prove terminal and agent-session continuity; anything else settles `identity_lost` and wakes.

**Reconnect.** On reconnect the monitor re-bootstraps and each supervisor refolds from its anchor. Resuming silently is allowed only when the reconnect snapshot proves the child's lifecycle did not advance; otherwise exactly one high-priority `evidence_gap` is emitted and supervision continues. If the socket cannot be restored the supervisor stays visibly degraded and retries with bounded jittered backoff. There is no polling fallback.

**Material events.** Every exact-child transition is recorded. Working starts are silent. The manager is woken for a completed work cycle, a block, reviewer attention, reviewer degradation and recovery, identity replacement or loss, release or exit, pane close, monitor degradation and recovery, and an evidence gap.

**Review cadence.** A child that has been working continuously for `wait.reviewCadenceMinutes` is reviewed with exactly `openai-codex/gpt-5.6-luna` at thinking `max`. Results store silently; `stalled`, `blocked`, `risk`, `appears_complete`, and `unknown` wake the manager and the supervisor stays active. A reviewer failure enters one visible degraded episode and retries at the next cadence, and the first success afterwards notifies recovery once. The reviewer never starts a Herdr agent and never selects a substitute model.

**Wake delivery.** Wakes are report-only, best effort, and never retried. Pi delivers through the existing `sendMessage` custom-context path with `deliverAs: "steer"` and `triggerTurn: true`. Claude delivers through the Claude Code Channels research preview served by the same MCP server: the server advertises `capabilities.experimental["claude/channel"]` and sends `notifications/claude/channel` with bounded content and meta. `manager-claude` opts in with `runtime.developmentChannels: ["server:herdr"]`, emitted as `--dangerously-load-development-channels server:herdr`. Organization `channelsEnabled` policy still applies and cannot be observed from this repository.

**Soft receipts.** Every material event carries an opaque `eventId`. `herdr_jobs get` returns the pending unobserved events and marks exactly those observed; `list` and the Pi active-job UI show unobserved counts. Event, transition, and reviewer history are bounded with explicit truncation counts. Nothing is resent.

**Lifecycle.** Supervisors are session-scoped and never persist across manager sessions. Manager-session shutdown cancels them. Exact-child termination settles them. `herdr_jobs cancel` is refused with `SUPERVISION_ACTIVE` while the child is live.

### `herdr_launch`

**Purpose:** Launch a named Pi or Claude agent from a strict profile, optionally deliver its first prompt, and return authoritative launch state. **No profile, no launch.**

**Input:**

```text
{
  name: string,                              // required, caller-chosen and unique
  profile: string,                           // required named profile
  overrides?: TypedProfileOverrides,         // optional typed overrides for the requested profile only
  placement?:
    { mode: "same_tab" }                    // default
    | { mode: "new_tab", tabLabel: string }
    | { mode: "existing_pane", target: TargetRef },
  label?: string,                            // pane label; default: name
  cwd?: string,                              // default: current Pi cwd
  focus?: boolean,                           // default: false
  initialPrompt?: string                     // optional prompt after readiness
}
```

Raw `kind`, `argv`, and `env` launch fields are rejected. Profiles are resolved from the manager session cwd using bundled, user, then nearest-project discovery; arbitrary valid named profiles are allowed. Each profile pins exactly `pi` or `claude` and supplies typed runtime flags, prompt source, timeout, permissions, and an ordered fallback graph of at most three reachable profiles.

Rules:

- `name` is required and must be unique according to an authoritative agent listing. The extension never generates a name or silently renames a collision.
- Default placement splits the current pane to the right in the current tab, with no focus change, current Pi cwd, and a pane label equal to `name` unless `label` is supplied. `new_tab` and `existing_pane` retain their existing explicit semantics.
- Profile body sources are created before topology mutation. Immediately before each `agent start` invocation, launch records a monotonic start-budget basis. When that attempt is selected, one condition-based, read-only readiness loop uses the remainder of the same absolute 120,000 ms startup budget; start return, sampling, and polling never reset it. Every sample is a fresh ordered `api snapshot` → `agent get` → `pane get` sequence and is evaluated only after all three reads complete, using that sample plus identity fields actually supplied by the selected `agent_started` record. No record or field carries across samples. Fixed-whitelist model-visible evidence resets before each sample, then retains each completed current-sample read; if pane-get fails, the completed snapshot and agent-get projections remain available without evaluating readiness. Duplicate target records, malformed non-null metadata, contradictory identity aliases, or replacement evidence is terminal. Missing/null noncontradictory startup metadata is pending only inside readiness. Every non-null lifecycle field from start or sample records is shape-validated: known `agent_status`, safe non-negative `state_change_seq`/`revision`, and boolean diagnostic `screen_detection_skipped`. Valid start lifecycle values are earlier process-start observations and are never merged into or compared with a later sample. A no-prompt launch requires the existing strict complete captured identity but no idle lifecycle baseline or lifecycle agreement.
- Before an initial prompt is submitted, the same readiness sample's authoritative `agent get` record must independently contain the full exact captured pane/terminal/name/kind/agent_session identity, exact idle state, and safe non-negative `state_change_seq` and `revision`. Same-sample snapshot-agent, snapshot-pane, and pane-get lifecycle fields must agree with this anchor when they supply a non-null value but cannot fill any anchor omission. Valid same-identity lifecycle disagreement is sequential transition/skew: the sample stays pending, is discarded, and is resampled without field merging or prompt submission. Valid non-idle anchor state and missing/null fields remain pending within the absolute startup budget; malformed lifecycle shapes, duplicates, identity contradictions, and replacement are terminal. Readiness returns this identity and baseline together, and launch performs no later one-shot baseline read. Phase remains `ready` throughout sampling, changes to `focus` for an explicitly requested post-readiness focus, and changes to `prompt_verification` immediately before stdin submission.
- The assignment is wrapped in the mandatory v1 envelope and submitted exactly once through `agent prompt --stdin` without `--wait`. A parsed `cli:agent:prompt` / `agent_prompted` response with the exact captured identity, `interactive_ready:true`, and safe `revision` confirms terminal injection only. Launch then runs a separate bounded 5,000 ms read-only confirmation loop at 100 ms cadence; this window neither reuses nor extends startup readiness. Every sample performs sequential `agent get` and pane reads under one shared cancellation window and carries no record from an earlier sample. Agent-get is the sole coherent source of status, sequence, and revision; pane-get proves identity continuity only, and lifecycle fields are never merged across records. `working`, `idle`, `blocked`, or `done` confirms only when the agent-get sequence strictly exceeds the baseline and its present revision has not regressed from the baseline or acknowledgement. Unknown, missing fields, unchanged/regressed sequence, missing/regressed revision, and same-identity transient skew remain unconfirmed until the deadline. `screen_detection_skipped` is bounded diagnostic metadata only and never validates, confirms, contradicts, or rejects.
- Replacement, disappearance, contradiction, read failure, timeout, or caller abort after acknowledgement fails closed as `LAUNCH_FAILED` with `causeCode:"PROMPT_UNCONFIRMED"`, `phase:"prompt_verification"`, `promptSubmitted:true`, `promptConsumption:"unconfirmed"`, bounded acknowledgement/submission evidence, baseline and last sequence/revision/state, sample count/timing, reason/source code, and created resource IDs. `PROMPT_UNCONFIRMED` means not proven, possibly consumed. Tools-only telemetry can false-negative a valid fast turn; this deliberate availability trade-off never authorizes retry, cleanup, recipient registration, or dependent assertions. A successful assignment reports `promptSubmitted:true`, `promptConsumption:"confirmed"`, and final observation/confirmation evidence. The prompt-confirmation phase never sends recovery Enter, invokes a runtime hook, invokes or retries prompt/start, falls back after submission, duplicates prompt bytes, or automatically cleans partial resources; the existing typed pre-assignment start-fallback contract remains unchanged.
- A launch without an initial prompt returns only after strict complete identity readiness, without requiring an idle baseline. Recipient registration occurs only after semantic initial-prompt confirmation succeeds (or immediately after no-prompt readiness). Registrations persist pane ID, terminal ID, agent name, agent kind, and the complete session object; optional `agent_id` is diagnostic only and never authorizes attachment delivery.
- Only exhaustion of the readiness loop's absolute deadline returns `READY_TIMEOUT`; an individual readiness-read `CLI_TIMEOUT` remains `LAUNCH_FAILED` with `causeCode:"CLI_TIMEOUT"`. A readiness timeout or caller abort after successful start preserves partial effects and returns `agentStarted:true`, `promptSubmitted:false`, `recipientRegistered:false`, created IDs, start-budget basis/elapsed time, sample count, last pending reason, fixed-whitelist bounded records, and `baselineRequired`. Grant-path and published-attachment evidence is retained. It performs no fallback, retry, cleanup, generated Enter, focus mutation, prompt submission, or recipient registration. Malformed, duplicate, identity-contradictory, and replacement failures preserve the same effect boundary. A post-readiness focus failure reports phase `focus`; its CLI timeout is `LAUNCH_FAILED` with `causeCode:"CLI_TIMEOUT"`, never `READY_TIMEOUT`.
- Overrides apply only to the requested primary profile. Every fallback uses its own untouched defaults, including runtime, model, source, timeout, and permissions. Profile `timeoutMinutes` is task policy; each Herdr start attempt uses one absolute valid 120000 ms start-plus-readiness budget, while the CLI subprocess receives a small execution margin.
- Automatic fallback is permitted only for the installed CLI failure envelope `{id:"cli:agent:start",error:{code:"agent_start_failed",message:"agent process exited before becoming interactive"}}` with non-killed exit 1 and untruncated stderr, followed by an authoritative pane read with `agent_status:"unknown"` and no agent identity/session fields. Timeout, malformed/protocol, identity/kind, prompt, and uncertain-state failures stop without fallback.
- Fallback attempts reuse the resolved pane; the ordered reachable profile chain is deterministic and capped at three. An exhausted chain stops and reports bounded attempt evidence; no profile is improvised.
- Launch details report requested and selected profiles, effective runtime/model/source/timeout/permissions, bounded attempt evidence, readiness timing/records, authoritative IDs/post-state, prompt submission/observation evidence, and any visible provenance. They include independent monotonic safe-integer durations for selected start through readiness, immediately before stdin submission through completion of typed acknowledgement parsing and identity validation, and validated acknowledgement through semantic confirmation; observed durations are never clamped to their configured maxima. Readiness diagnostics use a four-record fixed-whitelist projector: only fixed identity/lifecycle keys, bounded primitive values and malformed/missing markers, plus the four fixed agent-session fields survive. Arbitrary keys, nested trees, arrays, prototype-shaped properties, and oversized values cannot enter readiness records or readiness error metadata. Failed launches retain created resources and never auto-clean them. When a typed CLI failure reaches the launch boundary, argv calls retain bounded fixed-shape stdout/stderr evidence; stdin deliveries retain only non-textual stream presence/size/truncation. Raw stdin stdout/stderr and prompt bodies are never retained or published.

### `herdr_pane`

**Execution:** This mutating tool is registered with `executionMode: "sequential"` across all pane operations, including close.

**Purpose:** Perform pane topology mutations only: split, move, rename, focus, resize, swap, zoom, or close.

**Input:** a strict discriminated operation union:

```text
{
  operation: "split",
  target?: TargetRef,                         // default: current pane
  label: string,                              // required for created pane
  direction?: "right" | "down",              // default: right
  focus?: boolean,                            // default: false
  cwd?: string,
  env?: EnvMap
}

{
  operation: "move",
  target: TargetRef,
  destination:
    { kind: "tab", target: TargetRef }
    | { kind: "new_tab", label: string },      // label required
  direction?: "right" | "down",              // default: right
  focus?: boolean                             // default: false
}

{ operation: "rename", target: TargetRef, label: string }
{ operation: "focus", target: TargetRef }
{ operation: "resize", target: TargetRef, direction: Direction, amount: number }

{
  operation: "swap",
  source: TargetRef,
  with: TargetRef | Direction
}

{
  operation: "zoom",
  target?: TargetRef,                          // default: current pane
  mode?: "toggle" | "on" | "off"              // default: toggle
}

{ operation: "close", target: TargetRef }
```

Rules:

- Split defaults to a right split and no focus. `down` and focus changes are explicit only.
- A newly created pane must have a non-empty caller-provided label. `env` has no extension key allowlist and is passed to the CLI as an environment override. Environment contents may be visible to the child process and other Herdr clients; values are not echoed in normal tool text/details.
- Move may place an existing pane in an existing tab or a newly created, caller-labeled tab in the current workspace. Workspace creation/movement is not supported.
- `swap` accepts either a direction relative to `source` or an explicit second target, but never both.
- Resize requires a finite positive amount and an explicit direction.
- Close is autonomous after fresh topology validation for an exact non-caller target; it never asks for modal confirmation and never performs automatic cleanup or cascaded cleanup beyond Herdr's own close semantics.
- Close preserves completed mutation evidence: it captures the Herdr envelope ID/result, invokes the mutation with completed-mutation preservation, and performs an independent fresh post-topology read after dispatch even if the initiating signal aborts.
- If a dispatched close response is lost or invalid, one independent readback reconciles only proven target absence. Failures that prove dispatch never began (`CLI_NOT_FOUND` or `BACKEND_UNAVAILABLE`) propagate directly and never reconcile. Otherwise it throws `MUTATION_UNCERTAIN` with bounded original/readback evidence and never retries.
- Every successful mutation re-reads affected pane/layout/tab context and returns authoritative post-state. Close returns compact containing topology, operation ID, target ID, and removed IDs.

### `herdr_tab`

**Execution:** This mutating tool is registered with `executionMode: "sequential"` across all tab operations, including close.

**Purpose:** Create, rename, focus, or close tabs.

**Input:**

```text
{
  operation: "create",
  label: string,                              // required
  cwd?: string,                               // default: current Pi cwd
  env?: EnvMap,
  focus?: boolean                             // default: false
}
{ operation: "rename", target: TargetRef, label: string }
{ operation: "focus", target: TargetRef }
{ operation: "close", target: TargetRef }
```

Rules:

- Created tabs always have a caller-provided non-empty label and no focus unless explicitly requested.
- Environment overrides have no extension key restrictions and carry the visibility warning described for pane creation.
- Tab targets are stable tab IDs or `current`; no fuzzy tab-label resolution is added.
- Close is autonomous after fresh topology validation for an exact non-caller target and does not require UI access. The tool cannot close the tab containing the calling pane or cause the calling workspace to close.
- Close captures the Herdr envelope ID/result, preserves completed mutations across signal abort, performs a fresh post-topology read, and reconciles one lost/invalid response only when target absence is proven. CLI/backend unavailability before dispatch propagates without reconciliation. A present or unreadable target produces `MUTATION_UNCERTAIN`; the tool never retries.
- Every successful mutation re-reads authoritative tab and current-context state. A created tab's authoritative child pane metadata is included without inventing a pane ID.

## Settings

Settings are extension-owned and loaded only from `/home/gabriel/.pi/agent/extensions/herdr-tools/config.json`. Pi's typed settings schema has no extension namespace. Tool calls and project-local files cannot override these settings.

The optional extension-owned `config.json` uses this JSON shape:

```json
{
  "wait": {
    "reviewCadenceMinutes": 5,
    "reviewerModel": "openai-codex/gpt-5.6-luna"
  }
}
```

- `wait.reviewCadenceMinutes`: integer, default `5`, inclusive range `1..30`.
- `wait.reviewerModel`: model identifier, default `openai-codex/gpt-5.6-luna`.
- Reviewer thinking level is fixed to `low` and is not configurable by a tool call.
- `wait.reviewCadenceMinutes` is shared with the supervision reviewer. `wait.reviewerModel` is wait-only: the supervisor reviewer pins `openai-codex/gpt-5.6-luna` at thinking `max` in code, because it judges a child that has been working continuously with no transition to read.

If `config.json` is absent, use the specified defaults. If it is present but malformed or invalid, fail closed with `INVALID_SETTINGS`; do not coerce values or fall back to defaults or another reviewer model. A configured reviewer model that cannot be resolved or authenticated causes a long wait to fail with `REVIEWER_FAILED`; there is no fallback model.

The cadence is extension-wide and sampled for each wait. `herdr_wait` has no cadence, model, thinking, reviewer, or target-cap override fields.

## State and ownership model

Ownership is an in-memory property of the current extension runtime and current Pi session.

- A pane or tab created by this extension during the current Pi session is owned by the extension. Ownership follows the authoritative opaque resource ID through moves.
- Resources found by inspection, passed as existing targets, or created before the current extension runtime are unowned.
- Reload, resume, fork, new session, or any session change loses all ownership. Ownership must not be reconstructed from session entries, labels, timestamps, Herdr metadata, or a prior runtime.
- Ownership is not persisted in `pi.appendEntry` or any sidecar file.
- An explicit exact close is authorized for any non-caller target after fresh topology validation; ownership is not consulted for close authorization and no confirmation UI path exists.
- The pane containing the calling Pi agent, its containing tab, and its containing workspace are protected and can never be closed by these topology tools. Preflight must also reject an operation that would implicitly close one of those ancestors.
- Failed launches do not trigger ownership-based cleanup. Created resources remain available for inspection and manual closure.

Ownership checks are performed against fresh authoritative topology before close. A stale ownership map never grants permission to close an unowned resource.

## Error taxonomy

Errors are stable, concise, and machine-readable in structured details. At minimum, the implementation defines these codes:

- `HERDR_ENV_REQUIRED`: extension operation attempted without the required Herdr environment. Normally unreachable because tools are not registered when disabled.
- `CONTEXT_UNAVAILABLE`: required injected ID or current context is absent.
- `CLI_NOT_FOUND`: installed `herdr` executable is unavailable outside a compatibility preflight.
- `BACKEND_UNAVAILABLE`: CLI cannot reach the Herdr server/socket, including a failed compatibility preflight.
- `CLI_INCOMPATIBLE`: compatibility health is malformed or reports incompatible client/server versions; mutations stop before dispatch.
- `CLI_PROTOCOL_ERROR`: malformed or contradictory CLI output after compatibility preflight.
- `SUPERVISION_UNAVAILABLE`: automatic child supervision could not be reserved; the launch is refused with no effect.
- `SUPERVISION_UNCONFIRMED`: the child exists but supervision could not be bound to it; a partial-effect launch failure with child evidence, no retry, and no cleanup.
- `SUPERVISION_ACTIVE`: `herdr_jobs cancel` was refused because the supervisor's exact child is still live.
- `SUPERVISION_SOCKET_UNAVAILABLE`: `HERDR_SOCKET_PATH` is missing, malformed, or unopenable.
- `SUPERVISION_PROTOCOL_ERROR`: a value the Herdr socket sent failed strict validation; the connection is dropped rather than guessed at.
- `CLIENT_SERVER_INCOMPATIBLE`: health detects incompatible client/server versions or schemas.
- `INVALID_INPUT`: schema or cross-field validation failure.
- `INVALID_SETTINGS`: invalid extension-owned setting.
- `TARGET_NOT_FOUND`: no exact target match.
- `TARGET_AMBIGUOUS`: multiple exact target matches.
- `TARGET_TYPE_MISMATCH`: exact target exists but cannot serve the requested operation.
- `TARGET_BUSY`: normal prompt attempted against a working target.
- `SELF_TARGET_REJECTED`: inter-agent communication targeted the caller's own pane; no text was sent.
- `SENDER_IDENTITY_UNAVAILABLE`: the caller pane was absent from the fresh authoritative snapshot; no text was sent.
- `TARGET_STATE_UNKNOWN`: authoritative target state is explicitly unknown; no prompt or key bytes were sent.
- `TARGET_STATE_UNAVAILABLE`: authoritative target state is malformed or unavailable; no prompt or key bytes were sent.
- `KEY_REJECTED`: key is not a supported named key.
- `POSTSTATE_UNAVAILABLE`: mutation completed or may have completed, but authoritative post-state could not be read.
- `LAUNCH_FAILED`: launch failed; any created resources remain.
- `PROMPT_UNCONFIRMED`: one launch initial prompt was acknowledged as submitted, but same-agent semantic consumption was not proven within the bounded confirmation contract. It means **not proven, possibly consumed**, appears as the `causeCode` of `LAUNCH_FAILED`, and never authorizes retry or dependent work.
- `READY_TIMEOUT`: the selected start attempt's absolute launch-readiness deadline was exhausted. It is never inferred from a phase name or an individual `CLI_TIMEOUT`.
- `OWNERSHIP_LOST`: a required owned-resource fact is no longer valid in this runtime.
- `PROTECTED_RESOURCE`: operation would close the caller pane or its containing tab/workspace.
- `MUTATION_UNCERTAIN`: a dispatched destructive mutation has no trustworthy response and post-state cannot prove target absence.
- `ABORTED`: caller `AbortSignal` was aborted.
- `WAIT_REVIEW_REQUIRED`: a long wait cannot be supervised under the configured rules.
- `REVIEWER_FAILED`: any required in-process reviewer/model call failed.
- `MANAGER_JUDGMENT_REQUIRED`: reviewer ended the wait early because the result requires manager judgment.
- `CLI_TIMEOUT`: an individual CLI call exceeded its bounded internal timeout.
- `CLI_OUTPUT_OVERFLOW`: a CLI call produced more output than the host collects while streaming. The child is killed and the call fails with bounded evidence; output is never silently truncated into a partial envelope.
- `TURN_NOT_ACTIVE`: explicit cancel/interrupt requires an authoritative working turn.
- `TARGET_IDENTITY_UNAVAILABLE`: the snapshot or fresh agent read lacks pane, terminal, or complete agent-session identity.
- `TARGET_IDENTITY_CHANGED`: the stable pane/terminal/session identity changed between the snapshot and fresh agent read or final confirmation.
- `CANCEL_UNCONFIRMED`: one Escape was dispatched but cancel was not proven; target disappearance is never cancel success.
- `INTERRUPT_UNCONFIRMED`: one Ctrl-C was dispatched but same-agent termination or the strict agent-exited proof was not established.

A detached `herdr_wait` timeout is a normal structured job result with `matched: false`, not `CLI_TIMEOUT`. No error path may substitute a guessed ID, focused pane, fallback model, generic success, or automatic cleanup.

## Security and safety boundaries

- The extension is global code with full Pi permissions; it is trusted code and must remain narrowly scoped.
- Registration is gated by `HERDR_ENV=1`.
- All process execution uses `pi.exec` with explicit executable and argument arrays. No shell interpolation, command concatenation, arbitrary executable input, or direct socket protocol implementation is allowed.
- `herdr_launch` accepts only a validated named Pi/Claude profile and typed overrides; raw kind, argv, and env launch fields are rejected.
- Target resolution is exact and fail-closed. The extension never relies on UI focus or guesses an ID.
- Named keys are lower-level validated symbols rather than caller-supplied raw bytes. The existing `esc`, `escape`, and `ctrl+c` escape hatch remains available and is not routed through semantic turn control; key delivery does not add a second confirmation dialog.
- Destructive close operations are autonomous only after exact target and protected-topology validation. No UI is required, but malformed topology fails closed.
- Environment overrides accept arbitrary variable names by product decision. They can expose secrets or control process behavior to the launched child and may be visible through Herdr process/session inspection; normal tool output must not echo their values. Callers remain responsible for not supplying sensitive values in a shared session.
- That rule is enforced structurally, not per tool: every authoritative record a tool retains as evidence — inspect target metadata, wait target snapshots, launch post-state, and pane/tab post-state — passes through the one shared redaction in `src/redaction.ts`, and any host that projects `details` into model-visible content applies it again at that boundary, so a record added later cannot leak by omission. The redaction drops an environment-shaped key at any nesting depth, including inside arrays, whenever its value carries a string at any depth. Environment values are strings by contract, so that rule is fail-closed on anything that could hold one while typed diagnostics that legitimately use the name, such as the health `environment` presence booleans, survive.
- Every host bounds captured process output while it is still streaming, not only after a call settles. Crossing the documented ceiling kills the child and fails the call with `CLI_OUTPUT_OVERFLOW` and bounded evidence.
- Long-wait reviewers receive only bounded metadata/transcript deltas, have no tools, cannot mutate or communicate, and are not visible as Herdr panes. Reviewer failures fail closed.
- Every CLI and model call observes `AbortSignal`; close post-readback uses a fresh independent signal so completed destructive mutations cannot lose terminal evidence.
- The extension does not read, write, replace, or report state through `herdr-agent-state.ts`; Herdr's managed state integration remains the authority for the calling Pi pane's lifecycle state.
- Integration tests use a disposable named Herdr session and never mutate the active Courier workspace.

## TUI and output behavior

Each tool has a compact custom call/result row using Pi's extension renderer APIs:

- Call rows show the tool name, operation, and resolved human-readable target label/name when known.
- Result rows show a short status such as inspected, sent, waiting, launched, updated, or closed, plus IDs/statuses needed for the next action.
- `working`, `blocked`, `idle`/`done`, timeout, reviewer failure, protected, reconciled, and uncertain states use distinct semantic styling.
- `herdr_launch` streams bounded progress through `onUpdate` for supervision reservation, placement, readiness, explicit focus when requested, prompt verification, and supervision binding. A supervisor stores bounded transition, reviewer, and event progress on its own job for `herdr_jobs` inspection. `herdr_wait` stores bounded target-state and reviewer progress on the detached job for `herdr_jobs` inspection instead of using the initiating update callback.
- Default output never prints full transcripts, environment values, raw CLI JSON, or reviewer prompts. Expanded details may show the fixed bounded transcript and structured metadata.
- Errors render their stable code and concise reason. They do not look like successful operations.
- TUI-specific rendering is guarded by Pi mode capabilities; RPC receives structured results, and close operations never require interactive UI confirmation.

## Project structure

The implementation belongs only under the separate directory below:

```text
/home/gabriel/.pi/agent/extensions/herdr-tools/
├── SPEC.md                         # this specification
├── index.ts                        # global extension factory and seven registrations
├── package.json                    # only if dependencies/scripts are needed
├── config.json                     # optional extension-owned configuration
├── src/
│   ├── cli.ts                      # pi.exec-based Herdr adapter
│   ├── targets.ts                  # exact target resolution
│   ├── schemas.ts                  # strict public tool schemas/types
│   ├── ownership.ts                # current-runtime resource bookkeeping
│   ├── close.ts                    # protected-resource topology validation and compact summaries
│   ├── mutations.ts                # completed-mutation preservation and close reconciliation
│   ├── settings.ts                 # extension-owned settings validation
│   ├── wait-review.ts              # bounded, tool-less in-process reviewers
│   ├── supervision/                # automatic child supervision
│   │   ├── protocol.ts              # strict validation of every socket value
│   │   ├── socket.ts                # newline-delimited JSON client
│   │   ├── monitor.ts               # one multiplexed session event connection
│   │   ├── identity.ts              # exact-child pinning and move continuity
│   │   ├── events.ts                # transitions, material wakes, soft receipts
│   │   ├── reviewer.ts              # Luna-max supervisor review
│   │   ├── model-service.ts         # host-independent model registry/auth
│   │   ├── notify.ts                # Pi steer and Claude Channel wakes
│   │   ├── supervisor.ts            # one child's state machine
│   │   ├── registry.ts              # reserve → bind → settle coordinator
│   │   └── state.ts                 # the bounded view herdr_jobs publishes
│   ├── tools/                      # seven tool implementations
│   │   └── turn-control.ts          # strict cancel/interrupt protocol
│   └── tui.ts                      # compact call/result/progress rendering
├── test/unit/                      # mocked CLI/model unit tests
└── test/integration/               # disposable named-session tests
```

The tree is a plan, not a request to create implementation files in this task. Existing sibling extensions are not moved or modified. This directory is intended to be a standalone Git repository with no remote initially. The implementation phase must initialize it with `git init`, verify that no remote is configured, and create an initial commit containing the reviewed `SPEC.md` before implementation proceeds.

## Executable commands

The implementation phase must define and run these full commands from the extension directory:

```bash
cd /home/gabriel/.pi/agent/extensions/herdr-tools
git init
test -z "$(git remote)"
git add SPEC.md
git commit -m "docs: add reviewed Herdr Tools specification"
test "$(git rev-list --count HEAD)" -eq 1
git show --format= --name-only HEAD | grep -Fxq SPEC.md
test -z "$(git remote)"
npm install
npm run test:unit -- --coverage
HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration -- --session herdr-tools-integration
npm run typecheck
npm run lint
npm run build
```

The integration command must create/use only the disposable named session `herdr-tools-integration`, use explicit returned IDs, avoid the active Courier workspace, and tear down only its own fixture after assertions. It must not run against the default active Herdr session.

Before integration execution, the harness must verify the session name is disposable and not attached to the active Courier context. Launch diagnostics include bounded complete `agent_session` identity/fingerprint plus `initialPromptSubmission`. A live initial-prompt launch passes only as either semantically confirmed success or exact fail-closed `PROMPT_UNCONFIRMED` with one acknowledged submission and preserved effect evidence. Generic or unsafe failures remain failures, and an unconfirmed launch must not proceed to marker, interrupt, communication, or other dependent assertions. A consumption failure must surface from the five-second confirmation window rather than the later smoke path. Failed launch resources remain visible until diagnostics are recorded; fixture teardown may then clean only resources/session explicitly created by the test harness.

## Testing strategy

Testing is test-first. Tests are written before the corresponding implementation phase and must cover all changed files at 100% changed-file coverage, including branches for fail-closed behavior.

### Mocked unit tests

Mock `pi.exec`, CLI stdout/stderr/exit codes, target listings, post-state reads, resource records, `AbortSignal`, `onUpdate`, and in-process model calls. Cover:

- disabled registration and exact seven-tool registration;
- strict schemas and cross-field validation;
- exact ID/current/label/name resolution, missing and ambiguous matches;
- live caller-context rebinding after same-workspace and cross-workspace pane moves, unchanged coherent reads, bounded concurrent-move retry, unresolved/duplicate/incoherent/replaced/racing reads, and visible inspect diagnostics;
- current-context protection from UI focus;
- single-target 100-line inspect cap and collection compactness;
- health environment and client/server compatibility reporting;
- normal prompt refusal while working;
- explicit steer submission to idle/done/blocked/working targets with zero interrupt-key calls;
- named-key validation without confirmation;
- strict cancel/interrupt variants, snapshot plus fresh-agent identity binding, complete-string identity prefix-collision replacements, independently validated flattened session alias families, exactly-one-key dispatch, fixed wait/final-snapshot sequencing, abort races, state-change confirmation, duplicate-record rejection, disappearance and agent-exited rules, stable errors, bounded evidence, redaction, compact rendering, MCP parity/FIFO, and exact negative disposable integration;
- wait state semantics, literal/regex matching, any/all, immediate matches, bounded timeout final snapshots, abort, and internal CLI failures;
- every long-wait reviewer rule, including concurrent one-per-target calls, bounded deltas, no tools, manager-judgment early exit, and immediate reviewer failure;
- unique launch names, strict profile schemas, typed overrides, startup-timeout margins, real failure-envelope fallback, AgentInfo correlation, selected-attempt absolute readiness budgeting, ordered coherent samples with no cross-sample carry, current-sample snapshot/agent evidence retained across a pane-read failure without early readiness evaluation, lifecycle shape validation for prompt/no-prompt/start records, start-lifecycle time separation, pending same-identity lifecycle skew without field merging/submission, explicit `READY_TIMEOUT`, post-readiness `focus` phase, pending missing/null metadata, terminal malformed/duplicate/replacement evidence, same-sample authoritative idle baselines, advanced-sequence plus non-regressed-revision confirmation for every state, unchanged/regressed/missing counters, cross-record lifecycle skew, screen-flag diagnostics, fixed-whitelist readiness records/error metadata rejecting arbitrary keys, nested trees, arrays, prototype-shaped properties, and oversized values, readiness CLI failure preservation, readiness and post-ack abort partial effects, exactly one submission, no failed recipient registration, bounded `PROMPT_UNCONFIRMED` evidence, and failed-launch retention;
- all pane/tab topology operations and default direction/focus behavior;
- environment overrides without an extension key allowlist and without value echoing;
- autonomous exact pane/tab close, lost-response reconciliation, mutation uncertainty, compact post-topology evidence, malformed topology, and caller ancestor protection;
- AbortSignal propagation and malformed CLI output.

### Disposable-session integration tests

Use a uniquely named Herdr session created for the test run. Exercise the real installed CLI and a small set of supported agent kinds sufficient to validate launch, inspect, communicate, wait, pane topology, tab topology, post-state reads, and cleanup boundaries. Never create, close, move, or rename resources in the active Courier workspace. Capture the authoritative JSON and IDs from each response; do not infer them.

### Validation gates

All of the following must pass before implementation is considered complete:

- unit tests pass with 100% coverage for changed files;
- disposable named-session integration tests pass;
- typecheck passes;
- lint passes cleanly;
- build passes cleanly;
- the standalone repository checks pass: `git init` succeeds, no remote is configured initially, and the initial commit contains the reviewed `SPEC.md` before implementation proceeds;
- settings validation covers absent, valid, malformed, and invalid extension-owned `config.json` values and rejects tool-call/project-local overrides;
- no existing managed Herdr state file was changed;
- no raw Bash interception or deferred tool was added;
- no failed launch was automatically cleaned by the extension.

## Phased implementation tasks

1. **Scaffold and registration gate**
   - Acceptance: separate global entry point exists; disabled mode registers nothing; enabled mode registers exactly seven tools; existing sibling files are untouched.
   - Verify: mocked registration tests and typecheck.
   - Files: extension entry point, schemas/types, package scripts if required.

2. **CLI, health, and target gate**
   - Acceptance: all reads use `pi.exec`; health reports environment and compatibility; exact resolution is fail-closed; no ID inference exists.
   - Verify: mocked CLI tests covering every resolution outcome and post-state read.
   - Files: CLI adapter, target resolver, health/inspect tool.

3. **Inspect and communication gate**
   - Acceptance: inspect caps single transcripts at 100 lines, collections are compact, prompt/steer/keys obey their distinct preconditions and post-state verification.
   - Verify: unit tests for ordering, limits, busy targets, named keys, and aborts.
   - Files: inspect and communication tools, renderer details.

4. **Wait and reviewer gate**
   - Acceptance: state/output conditions, any/all, explicit timeout, timeout snapshots, and mandatory bounded review supervision using the configured reviewer model match this specification.
   - Verify: mocked concurrent reviewer/model tests, failure/manager-judgment tests, and any/all integration waits.
   - Files: wait tool, review supervisor, settings.

5. **Launch and topology gate**
   - Acceptance: launch and pane/tab mutations use explicit placement, labels, resource bookkeeping, autonomous exact close, protected ancestors, and authoritative post-state reads.
   - Verify: mocked mutation/ownership tests followed by disposable-session integration tests.
   - Files: launch, pane, tab, ownership, CLI adapter.

6. **TUI and release validation gate**
   - Acceptance: compact custom rows and streamed progress are available without leaking raw output or environment values; all required commands are clean.
   - Verify: renderer tests, full coverage, typecheck, lint, build, and disposable integration run.
   - Files: renderers and only the files changed by the prior phases.

## Success criteria

The feature is complete only when all of the following are true:

- A Pi process outside Herdr exposes none of the seven tools.
- A Pi process inside Herdr exposes exactly the seven named core tools and no deferred tool.
- Every target operation uses an exact stable ID/current context, exact pane label, or unique agent name and fails closed otherwise.
- Inspection has the specified current, single-target, collection, and health behavior.
- Communication distinguishes normal prompt, explicit steer, named keys, cancel, and interrupt; normal prompt never interrupts a working target; steer never synthesizes an interrupt; turn control binds one key to one stable working identity and independently verifies the outcome.
- Wait supports the specified raw/semantic states, literal/regex output, any/all, explicit one-hour maximum, structured timeout snapshots, and mandatory reviewer supervision for long waits.
- Reviewer calls are in-process, tool-less, concurrent per target, bounded, non-mutating, fixed at low thinking, use the extension-owned reviewer model (default `openai-codex/gpt-5.6-luna`), and fail immediately without fallback when unavailable.
- Launch requires a unique caller name and supported kind, uses the specified placement defaults, supports argv without arbitrary executables, verifies initial work, streams progress, and never cleans failed launches.
- Pane and tab topology operations implement the specified defaults, labels, environment behavior, autonomous exact close, protected ancestors, bounded reconciliation, and authoritative post-state.
- Results are structured and concise, custom rows are compact, and waits/launches stream progress.
- Abort signals reach CLI and model work.
- Mocked unit tests achieve 100% changed-file coverage; disposable named-session integration tests, build, lint, and typecheck are clean.
- Settings are loaded only from the extension-owned `config.json`; an absent file uses the documented defaults, while malformed or invalid present settings fail closed with `INVALID_SETTINGS`, without coercion or fallback, and tool calls/project-local files cannot override them.
- The extension directory is a standalone Git repository with no remote initially, and its initial commit contains the reviewed `SPEC.md` before implementation proceeds.
- Only files under `herdr-tools` are introduced for this feature; `herdr-agent-state.ts` and `herdr-question-alert.ts` remain untouched.

## Assumptions and review notes

1. “Long wait” means a requested timeout longer than the global review cadence. This makes the mandatory reviewer behavior deterministic without adding a per-tool threshold setting.
2. Pi's typed settings schema has no extension namespace. Extension-owned settings are loaded only from `/home/gabriel/.pi/agent/extensions/herdr-tools/config.json`; tool calls and project-local files cannot override them. An absent file uses the documented defaults, while a malformed or invalid present file fails closed with `INVALID_SETTINGS` without coercion or fallback.
3. The installed Herdr CLI may add or remove supported agent kinds or adjust output fields. The adapter treats the installed CLI as authoritative and reports compatibility/protocol failures instead of guessing.
4. Herdr exposes no dedicated semantic steer command. `agent prompt` writes text plus Enter directly to the agent PTY; a working agent's own TUI determines how that input is handled. The extension must never synthesize steering by sending Escape first.
5. New tabs may cause Herdr to return an initial child pane. That pane must be labeled from the caller's requested/default launch label before it is used.
6. Ownership bookkeeping intentionally does not survive extension reload or Pi session changes, even when the Herdr resources remain alive; close authorization is based on the explicit exact target and fresh protected topology, not ownership.
7. The extension directory is a standalone Git repository with no remote initially. The implementation phase must run `git init`, verify the empty remote list, and create the initial commit containing the reviewed `SPEC.md` before implementation proceeds.

There are no approved open product questions for the core scope. Any implementation ambiguity not resolved by this document must fail closed and be raised for review rather than expanded into a new capability.

## Boundaries and implementation style

- **Always:** use strict TypeScript types and Pi custom-tool schemas; use `StringEnum` for string enums where required by Pi provider compatibility; pass `AbortSignal`; use explicit CLI argv; validate before mutation; re-read authoritative post-state; keep output bounded; run tests before release validation.
- **Ask first:** adding dependencies, changing the extension-owned settings path or JSON schema, changing the seven public schemas, changing ownership lifetime, adding a new Herdr command group, or touching an existing managed extension.
- **Never:** edit `herdr-agent-state.ts`; add compatibility aliases; add deferred tools; infer IDs; target UI focus implicitly; execute arbitrary commands/executables; send raw key sequences; read settings from Pi's global namespace or project-local files; accept tool-call settings overrides; auto-clean failed launches; auto-close unowned/mixed resources without UI; use fallback models or generic success fallbacks; mutate the active Courier workspace in integration tests.

The implementation should keep CLI access, target resolution, ownership, wait supervision, tool registration, and TUI rendering modular. It should follow Pi's custom-tool result shape and renderer lifecycle from the reviewed extension API documentation without introducing an abstraction that is not required by these contracts.
