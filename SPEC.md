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

The one exception is automatic child supervision, which observes the local Herdr socket read-only. Supervision issues exactly `session.snapshot` and `events.subscribe`, one request per connection, over newline-delimited JSON at `HERDR_SOCKET_PATH`, validates every value the server sends against the installed `herdr api schema`, and never mutates anything. Every mutation, and every operation of the seven tools, still goes through the CLI. See `docs/specs/auto-child-supervision.md` and ADR-019.

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

- `context` is the default, resolves the caller's current pane/context through the shared live context resolver, and uses the same single-target payload: authoritative metadata plus at most the 100 most recent unwrapped output lines, in order. Its structured details visibly include injected IDs, effective IDs, and whether rebinding occurred. Context mode also reports bounded, token-free caller-policy evidence (ADR-030): `scope` (`unrestricted`, `worker`, or `unavailable`), the classification `basis`, a bound worker's `replyPaneId` or an unavailable binding's reason, and a failure `code` when the policy evidence itself is malformed. Identity token values are never echoed; a caller whose policy evidence is unusable still receives a usable inspection.
- `target` reads exactly one resolved pane/agent target and returns authoritative metadata plus at most the 100 most recent unwrapped output lines, in order. The line cap is fixed and cannot be overridden by the tool call.
- `collection` returns compact metadata only for the requested current-context collection. It does not include pane transcripts, full process output, or a per-item 100-line payload.
- `health` returns environment presence, client status/version, server status/version, socket reachability as available, and an explicit client/server compatibility result. Secret values and full socket paths are not exposed; presence and safe diagnostic labels are sufficient.
- Invalid combinations, such as a target in health mode or a missing collection in collection mode, fail before the CLI mutation/read sequence.

**Structured result:** `kind`, normalized current/target/collection metadata, authoritative raw metadata fields where needed for forward compatibility, and for a single target `recentUnwrappedLines` capped at 100. Collection entries contain only compact IDs, parent IDs, labels, agent names, and states available from the authoritative response.

### Inter-agent message provenance

Every cross-pane text delivery made by `herdr_communicate` (`prompt` or `steer`) and every `herdr_launch` Task prompt is wrapped in this mandatory recipient-visible envelope:

```text
[HERDR AGENT MESSAGE v1]
from: coordinator (w1:p1)
kind: steer
authority: agent; not user/owner
payload: all text after this blank line is sender-authored

<caller-supplied payload>
```

The extension generates the complete header; callers supply only the payload and cannot override or suppress provenance or authority. `kind` is `assignment` for launch initial prompts and preserves `prompt` or `steer` for communication unless the caller marks a worker report with `kind: "result"`. Sender display identity is resolved from the fresh authoritative snapshot in this order: explicit agent name, pane label, agent kind, then the stable pane ID alone. The pane ID is always included. If the caller pane is absent from the fresh snapshot, delivery fails with `SENDER_IDENTITY_UNAVAILABLE` before sending text. `herdr_communicate` rejects a target whose pane ID equals the caller pane ID with `SELF_TARGET_REJECTED`.

The first-line sentinel and version are stable protocol. All metadata values are normalized to one line so they cannot inject fields; the original payload is preserved after the single separating blank line. This is clear cooperative provenance, not cryptographic authentication: ordinary terminal or raw Herdr CLI/API input can imitate the text, and those paths are outside this extension's guarantee. Named-key delivery is control input, not a message, and is never wrapped.

### `herdr_communicate`

**Execution:** This mutating tool is registered with `executionMode: "sequential"` so communication and turn-control calls cannot overlap.

**Purpose:** Send a normal prompt, explicitly steer an agent, send named keys, request safe cancellation, or request a stronger interruption. Prompt, steer, and keys operations do not wait for turn completion; cancel and interrupt perform bounded authoritative settlement confirmation.

**Input:** exactly one of these operation shapes:

```text
{ target: TargetRef, operation: "prompt",    text: string, kind?: "result" }
{ target: TargetRef, operation: "steer",     text: string, kind?: "result" }
{ target: TargetRef, operation: "keys",      keys: NamedKey[] }
{ target: TargetRef, operation: "cancel" }
{ target: TargetRef, operation: "interrupt" }
```

Rules:

- **Cooperative caller policy (ADR-030).** Before any send, the effective caller pane is classified from the authoritative snapshot. A caller with no `identity_provenance=launched` marker (detected or adopted — the legacy floor) is unrestricted. A launched manager or planner carries `identity_scope=orchestrator` and is unrestricted immediately, before its first child exists. A caller recorded as `identity_actor` on at least one other pane also manages children and is unrestricted toward every pane. Any other launched caller with no recorded children is a **leaf worker**: its `prompt`/`steer` sends (including `kind: "result"`) may target only its own `identity_actor` pane, and `keys`, `cancel`, and `interrupt` are refused entirely. The check runs after exact target resolution so an exact alias for the bound manager compares equal, and before recipient lookup, attachment publication, fresh-state reads, or dispatch, so a denied call performs no sends; the same classification gates turn control before any target state read or key. Missing, malformed, unrecognized, or contradictory provenance or scope evidence fails closed as `CALLER_POLICY_UNAVAILABLE`; a leaf whose binding is missing, self-referential, or stale (the actor pane is gone, or `identity_session` no longer equals the caller's current `agent_session.value`) fails closed as `CALLER_BINDING_UNAVAILABLE`; a leaf send to any other pane fails as `TARGET_SCOPE_REJECTED`. This is a cooperative routing restriction, not an authorization boundary — the tokens remain forgeable shared metadata, and `herdr_wait`, `herdr_jobs`, `herdr_launch`, `herdr_pane`, and `herdr_tab` stay unscoped for every caller.
- `prompt` and `steer` accept optional `kind: "result"` to mark the envelope as a worker report to its manager; omission keeps the `kind: prompt|steer` envelope byte-identical, and the control variants reject the field. A result envelope is a report, never an instruction or acknowledgement; managers state the expected reply pane explicitly in assignments.
- Every operation reads and classifies the authoritative pre-state before sending bytes. `unknown` or malformed state returns a typed no-send error.
- `prompt` and `steer` resolve the authoritative sender from the same fresh snapshot used for target resolution, reject self-targeting, and send the mandatory v1 inter-agent envelope. There is no raw-text or provenance opt-out.
- `prompt` submits through the identical direct `agent prompt --stdin` path an explicit steer uses, for every sendable state (`idle`, `done`, `working`, `blocked`). The target runtime and server decide how submitted input lands — Pi steers a running turn, Devin queues for the composer flush, and a server-side `agent_blocked` rejection still surfaces as `TARGET_BLOCKED` — while the envelope `kind` and `route` record the declared prompt semantics. The prompt/steer distinction is caller intent, not a delivery gate.
- `steer` never sends Escape or any other interrupt key. For idle, working, done, or blocked targets it submits the text directly through Herdr's `agent prompt --stdin` path; when the agent is working, its own TUI receives that submitted prompt as steering input. Prompt and steer use no Herdr `--wait` flags because the CLI's optional working-state observation can report `agent_prompt_stalled` after accepting the text, especially when screen detection is skipped. Unknown or malformed state is a typed no-send failure.
- Before every text submission, the extension joins the fresh snapshot agent record with fresh `agent get` and pane evidence. Communication has no start record, so this fresh join must establish the exact pane ID, terminal ID, agent name, agent kind, and complete `agent_session` `{source,agent,kind,value}`; every supplied field must agree, and missing/null fields are not fabricated. Missing, malformed, or contradictory identity fails closed before stdin is opened; a pane/name/kind match alone is never sufficient. When the agent name is the sole missing join field on a detected target whose kind is in `LAZY_ADOPT_KINDS` (`devin`, `pi`, `claude`), the caller first attempts lazy target adoption through `adoptUnnamedTarget` — re-reading authoritative records, minting the derived `<kind>-<paneId>` name through `agent rename` with `-2`…`-9` collision suffixes, verifying the post-mint identity through the same join, and stamping advisory adoption provenance attributed to the caller pane — then retries the join with the minted record appended. Adoption runs only after the cooperative caller policy and the qualified-recipient gate; any other gap, an unsupported kind, or a failed mint falls through to the canonical refusal.
- A parsed `cli:agent:prompt` / `agent_prompted` envelope with that exact captured identity plus interactivity proof is the atomic submission acknowledgement. `interactive_ready:true` is the managed proof. Detected and adopted panes never emit `interactive_ready` — the server sets it only for managed agents — so an acknowledgement that omits it is accepted only when it carries a known live `agent_status` of `idle`, `working`, `blocked`, or `done` (the detection proof); `interactive_ready:false`, a `launch_pending` other than absent/`false` (a managed agent started but not yet interactive, or a malformed value), `agent_status:"unknown"`, and a missing lifecycle status all remain fail-closed. The acknowledgement confirms that Herdr accepted the wrapped bytes, not that the agent started or completed a turn. A malformed, mismatched, or failed acknowledgement is terminal; the extension never resubmits or presses Enter.
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

Turn control is fail-closed and only applies to an authoritative `working` target. After exact snapshot resolution — and only after the caller-policy classification has admitted the caller — the extension requires exactly one target pane record and exactly one target agent record, then performs one fresh `herdr agent get` against the resolved pane ID. When the agent name is the sole missing join field and the target kind is in `LAZY_ADOPT_KINDS`, the same `adoptUnnamedTarget` lazy-adoption step runs before the join; the minted record joins the evidence set and later fresh reads see the name natively. The records are strictly joined: repeated pane/terminal/name/kind/session/state/parent evidence must agree, with no object-spread overwrite. The snapshot and `agent get` must report the same `working` agent, and the fresh `agent get` must carry its own non-empty `pane_id`; the extension never fills that required field from the earlier snapshot. Missing records or identity is `TARGET_IDENTITY_UNAVAILABLE`; a changed or contradictory identity is `TARGET_IDENTITY_CHANGED`; a non-working target is `TURN_NOT_ACTIVE`; existing unknown or malformed state errors remain typed and no key is sent.

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

Long waits use mandatory in-process, tool-less reviewer calls only for targets without active exact-child supervision:

- The reviewer model is the extension-owned setting from `config.json`, default `openai-codex/gpt-6-sol`; the tool cannot select or override it.
- Reviewer thinking is fixed at `low`; the tool cannot select or override it.
- After each latest authoritative target observation and immediately before dispatch, the wait partitions targets between active bound supervisors and the explicit reviewer. A covered target receives no wait-reviewer request. Uncovered targets receive one independent reviewer call each, concurrently, with no target-count cap.
- Reviewer construction is lazy. An all-covered long wait does not resolve or authenticate the wait reviewer. Native lifecycle waits are still bounded into review windows so authoritative waiting is not bypassed.
- Reviewer calls are not Herdr panes, are invisible in Herdr topology, receive no tools, and cannot mutate or communicate. A degraded but live supervisor remains the semantic-review owner; the wait reviewer is never a hidden fallback.
- Each reviewer receives only bounded transcript deltas since that target's previous explicit review plus compact authoritative metadata. The bounded transcript input is at most the same 100 recent unwrapped lines used by single-target inspection; unchanged lines must not be resent when a smaller delta is available.
- A reviewer may summarize/classify only `progress`, `stalled`, `blocked`, `risk`, `appears_complete`, or `unknown` and may provide a bounded summary. `appears_complete` is advisory and never satisfies the wait predicate.
- A reviewer result requiring manager judgment ends the job early with `matched: false`, `wait_result: "manager_judgment_required"`, `reason: "manager_judgment_required"`, final snapshots, and reviewer summaries.
- Reviewer/model failure ends the job immediately with terminal `wait_result: "failed"` and `REVIEWER_FAILED`; there is no fallback model, pane, or silent continuation for an unsupervised target.
- An `unknown` classification is retained but does not require manager judgment only when a fresh exact authoritative agent read performed after the review proves the same occupant is `working`. State waits may reuse that post-review read. Output metadata alone is insufficient; an output wait must retain the final post-output exact agent state or perform a dedicated read. Missing, malformed, timed-out, contradictory, or non-working evidence cannot suppress `unknown`.
- Reviewer summaries appear in detached job progress and final `herdr_jobs` details. The reviewer never changes the authoritative wait condition: only the native Herdr predicate or composite output observation can satisfy it. Supervisor events and reviewer findings remain on the supervisor job.
- Each cadence publishes a bounded typed `JobDetail.semanticReview` projection with covered supervisor entries, explicit reviewer target IDs, and omission counts independently from truncatable progress details.

### Detached wait jobs and `herdr_jobs`

`herdr_wait` has no execution-mode field. Its schema is strict: every unknown field is rejected. Every call performs parameter validation, extension-owned settings loading, live caller-context resolution, exact target resolution, identity/generation capture where required, and duplicate resolved-resource rejection before registering anything. When strict identity is required and a detected target's sole missing join field is the agent name on a `LAZY_ADOPT_KINDS` kind, the shared `adoptUnnamedTarget` lazy-adoption step mints and verifies the derived name before the binding join, exactly as in `herdr_communicate`. These preflight steps use the initiating tool signal and throw directly on failure without creating a job.

After preflight, the extension always registers a stable opaque `job_${randomUUID()}` identifier and runs the prepared wait engine under a fresh per-job `AbortController`. The prepared parameters, settings, resolved IDs, and opaque target-generation references are copied at registration. Timeout starts after registration. The initiating signal, call-scoped update callback, and synchronous result path are never used by post-registration work. A session generation check prevents stale preflight from registering into a replacement session. The tool returns the detached acknowledgement immediately; all later operation phases, terminal `wait_result` values, progress, reviewer evidence, and cancellation evidence are read through `herdr_jobs`.

The registry holds two job kinds. A `kind: "wait"` job is the detached wait described here. A `kind: "supervisor"` job is created automatically when `herdr_launch` starts a child and watches it for its whole life. An AGY launch can fail after prompt submission while leaving its supervisor published for recovery. Both kinds are listed, inspected, and shut down through `herdr_jobs`, and there is no eighth public tool.

The in-memory, session-wide registry has no concurrency cap and retains terminal jobs until shutdown. Its public operation phases are exactly `accepted`, `running`, `cancel_requested`, and `settled`. A supervisor also exposes `reserved`, `provisional`, `active`, `degraded`, or `settled` supervision state. `provisional` is legal only for AGY, remains `running` and live, carries no full native `agent_session`, keeps `request.targetIds: []`, and provides no exact coverage. `wait_result` is absent before `settled` and, at settlement, is exactly one of `condition_met`, `timed_out`, `manager_judgment_required`, `failed`, `cancelled`, or `unknown`. Terminal transitions are first-wins, and only latest bounded progress is stored. `herdr_jobs` is the sole public registry view and is strict:

- `{operation:"list", operation_phase?, kind?, offset?, limit?}` filters by operation phase and optionally by job kind, orders newest-first by insertion sequence, filters before pagination, defaults offset to `0` and limit to `20`, caps limit at `100`, and returns `{total,nextOffset,jobs}` with transcript-free summaries.
- `{operation:"get", jobId}` returns a bounded, typed full current or settled detail for an owned job. For a supervisor it also returns the pending unobserved supervision events and marks exactly the events it returned observed. A settled target observation carries structured `target_evidence` with its kind, observation timestamp, opaque target-generation reference, `currency: "historical_non_current"`, and evidence source; it is never current target truth.
- `{operation:"cancel", jobId}` is refused with `SUPERVISION_ACTIVE` for a supervisor whose exact child is still live or whose AGY child remains provisionally live. Otherwise it closes the operation gate and advances its fence before publishing `cancel_requested` or aborting the runner. It waits for bounded runner/command/callback quiescence: only observed drain settles `wait_result: "cancelled"`; uncertainty settles `wait_result: "unknown"` with `CANCELLATION_UNCERTAIN`. A settled job is returned unchanged, and unknown IDs are structured `JOB_NOT_FOUND`.

On session shutdown, notification delivery is disabled first, running jobs are fenced and aborted, in-memory jobs are discarded, and registry ownership/generation is reset. `/tree` does not cancel jobs. Terminal notifications are one-shot, visible, best-effort Pi messages; they make no delivery or consumption claim. Explicit cancellation and shutdown cancellation never notify. Manager-judgment notifications start with `HIGH PRIORITY: MANAGER JUDGMENT REQUIRED` and use details priority `high`; every other terminal notice uses normal priority. Notification text and details identify the job ID, operation phase, terminal wait result when present, reason, requested/matched targets, and only bounded evidence kinds or error summaries, treating pane/output text as untrusted data.

All model-visible content, list summaries, terminal notifications, and renderers enforce Pi's 50KB/2,000-line bounds with explicit truncation and no full transcripts. No background resource starts in the extension factory; only tool execution registers jobs.

#### Active wait visibility

`label` is valid for every detached wait. A supplied label is a bounded non-empty printable single-line value. When omitted, preflight derives one bounded effective label from resolved target names plus the requested state/output condition (for example, `worker-pi +2 → completed`). A supplied label appears in the call row and detached acknowledgement. An omitted label cannot be derived until asynchronous target preflight finishes, so it appears in the acknowledgement rather than the already-rendered call row. Detached jobs store the effective label in request details and list summaries, so `herdr_jobs` and the TUI expose the same identity unless an aggregate projection explicitly marks the label truncated; duplicate labels are allowed because exact actions continue to use `jobId`.

While detached jobs are active, the extension owns one session-scoped Pi footer status. It renders an animated spinner, the exact active count, the elapsed time of the oldest active job, and the `/herdr-waits` hint, refreshing once per second. The timer starts only when an active job exists and stops immediately when none remain. Status/UI failures never alter registry state.

`/herdr-waits` is a read-only toggle for an above-editor active-job widget. Each visible row contains the effective label, current elapsed time, and exact job ID. Pi bounds string-array widgets to 10 lines, so the extension uses at most 10 total lines and reserves the final line for an omission count when more jobs are active. It clears while the active set is empty but remembers the enabled preference for the current session, so a later wait restores it automatically. A session transition clears footer/widget state, stops the timer, and resets the toggle. Inspect and cancel remain `herdr_jobs` operations; terminal notifications remain unchanged.


### Automatic child supervision

Every `herdr_launch` child — one per Task replica — reserves supervision before its first topology mutation in phase `supervision_reserve`. A reservation failure refuses launch with `SUPERVISION_UNAVAILABLE` and `effectCertainty: "absent"`. Pi and Claude retain strict complete native-session readiness and exact binding before prompt dispatch. Every launch carries the canonical Task, so there is no promptless launch path. Prompt confirmation remains a separate launch-success gate. Supervision is observation and notification only: it never mutates the child, never gates its work, and never becomes a public tool.

**Pi and Claude bind exactly.** Phase `supervision_bind` follows readiness and precedes prompt dispatch. Binding validates a fresh authoritative snapshot, drains queued evidence while the public view remains `reserved`, and commits the selected operating point, selected kind, and `request.targetIds: [exactPaneId]` before publishing bound `active` or `degraded` state. A queued closure, release, replacement, identity loss, or failed commit makes bind reject as `SUPERVISION_UNCONFIRMED`. It rolls back request fields to `targetIds: []`, releases only the unbound reservation, and performs no prompt, recipient registration, retry, or child cleanup. The child and binding evidence remain available for inspection. Candidate fallback stays inside `agent_start`, before Pi or Claude binding and before AGY provisional publication.

**AGY binds provisionally, then strengthens.** The fixed non-sensitive `--prompt-interactive` bootstrap is the last AGY start argument and establishes the native AGY session before the real Task prompt. A coherent pre-prompt readiness sample must prove one idle AGY occupant's pane, terminal, name, kind, sequence, and revision; the existing provisional path accepts a pre-existing native `agent_session` without putting the Task in argv. The registry then commits and publishes the AGY-only `provisional` state on the same mutation chain. After exactly one prompt submission, one observer-backed strengthening task takes a fresh authoritative snapshot, requires the official full native session and lifecycle advancement on the same identity, and drains every event admitted during the provisional window in arrival order. Only then may it atomically publish `active` or `degraded`, `request.targetIds: [exactPaneId]`, and exact coverage. A move, replacement, contradiction, duplicate, malformed record, failed read, missing session, sequence failure, revision regression, or settlement rejects strengthening and retains the provisional supervisor.

After exact Pi or Claude bind succeeds, a later prompt, recipient, or rendering failure never releases or cancels the supervisor. After a prompt might have taken effect, any transport, acknowledgement, semantic-confirmation, identity, or strengthening failure retains the child, running supervisor, evidence, and recovery handles. The launch never retries prompt or start, falls back, sends Enter, cleans up, releases the reservation, registers a recipient or attachment capability, or authorizes dependent work. The only fallback remains an exact non-killed, untruncated pre-interactive `agent_start_failed` result followed by fresh authoritative proof that no agent exists. A successful launch returns the stable supervisor job ID.

**One session connection and one shared reconciliation loop.** Supervision holds one long-lived connection to `HERDR_SOCKET_PATH` for the whole manager session, carrying a single acknowledged `events.subscribe` and multiplexed across every supervisor. Herdr 0.8.2 answers exactly one request per connection, so the subscription set is fixed: `pane.updated`, `pane.closed`, `pane.exited`, `pane.moved`, and `pane.agent_detected`, which also rules out per-pane `pane.agent_status_changed`. `pane.updated` carries a full `PaneInfo`, so it is the low-latency status channel. Bind reads and periodic `session.snapshot` reconciliation reads use separate short-lived unary connections.

The monitor owns one fixed periodic reconciliation loop while at least one supervisor is live. It attempts one shared `session.snapshot` every 30 seconds on fixed monotonic due times, never one attempt per child, never overlaps attempts, and skips delayed catch-up bursts. A 5-second connect bound and separate 10-second request bound give a proven 45-second stale-status bound when the next attempt succeeds. The loop stops when there are no observers or the session shuts down. Failed or invalid reads preserve the last proven projection and expose visible reconciliation degradation; they do not start CLI polling or a hidden reviewer fallback.

**Identity, anchoring, and visible gaps.** An exact supervisor pins `pane_id`, `terminal_id`, the agent name and kind, and the whole four-part `agent_session`, and anchors on the pane `revision` its bind or strengthening snapshot observed. Pane IDs are reused across the durable event log, so thin events normally trigger reconciliation instead of proving lifecycle identity. One implemented exception is `pane_exited`: when it reports a non-clean exit for the currently bound pane ID, the supervisor latches `process_exit` before reconciliation. The event has no occupant identity, so a delayed exit from a prior occupant of a reused pane ID can be attributed to the replacement child. Every accepted event is validated on its own fields at the protocol boundary. Replay and event deduplication use the pane revision alone. A full event jump above the watermark emits one high-priority source-`event` `evidence_gap` with the omitted intermediate count before adopting its endpoint. An equal-revision status contradiction emits the same visible gap. A higher valid snapshot revision emits one source-`snapshot` `evidence_gap`, even when endpoint status is unchanged, then adopts that authoritative status and revision. Proven pane moves rebase to the destination's pane-local revision and never compare origin and destination revisions. Malformed, duplicate, contradictory, or lower-revision target-local snapshot evidence preserves the last projection and degrades visibly instead of settling a live supervisor.

**Reconnect.** On reconnect the monitor re-bootstraps and applies the same target-local identity and revision rules as periodic reconciliation. A higher snapshot revision emits one high-priority `evidence_gap` and adopts the status and revision that snapshot proves; an unchanged revision resumes silently. If the socket cannot be restored the supervisor stays visibly degraded and retries with bounded jittered backoff. Periodic reconciliation remains the shared correctness channel; no CLI polling fallback exists.

**Material events.** Every exact-child transition is recorded. Working starts are silent. The manager is woken for a completed work cycle, a block, reviewer attention, reviewer degradation and recovery, identity replacement or loss, release or exit, pane close, monitor degradation and recovery, reconciliation degradation and recovery, and an evidence gap.

**Review cadence.** A child that has been working continuously for `wait.reviewCadenceMinutes` is reviewed by the supervisor reviewer, whose model is the module constant `SUPERVISION_REVIEWER_MODEL` = `typesafe/jev-latest` (`src/supervision/reviewer.ts`), not a setting and unrelated to `wait.reviewerModel`. Each review issues one `systemOne` call carrying six independent `noul` predicates, `evidence_sufficient`, `making_progress`, `stalled`, `blocked`, `risk`, and `appears_complete`, plus one `reason` choice. The bounded V2.1 state contains the authorial `supervisionDigest.doneWhen` and `constraints`, a compact runner trace, a Git workspace view, supplemental terminal lines, version identity, and the previous review's classification and signals. The production carrier does not copy the Task's `objective` into reviewer evidence, and the public schema has no `progressMarkers` field, so `assignment.objective` is absent and `assignment.progressMarkers` is empty. `supervisionDigest.readOnly` is a code-owned Tier-0 policy fact and is not part of the reviewer assignment section.

The Git base is pinned during reservation. A pin failure refuses launch before child effects. At cadence, an unavailable workspace skips the deterministic read-only dirty-workspace check. The porcelain parser consumes a rename source record only when the index status column is `R` or `C`; a valid worktree-column rename or copy can therefore produce `output_malformed` and make workspace evidence unavailable for that cadence. The local outbound scan is pattern-based. `safe` means no configured detector matched, not that arbitrary credentials are proven absent.

Deterministic classification runs through `reduceSupervisionReview` (`src/reviewer.ts`): `risk` (at least 0.60) and `blocked` (at least 0.65) are evaluated before the evidence gate; insufficient evidence then yields `unknown`; `appears_complete`, `stalled`, and `progress` follow at their documented thresholds, with the first-observation stalled threshold raised to 0.85. A review whose work cycle ends while evidence collection or the model call is in flight is abandoned rather than stored or announced. Code-owned attention keeps baseline-grace `unknown` silent and wakes for later `unknown`, `stalled`, `blocked`, `risk`, or `appears_complete`. Reviewer infrastructure failure is silent and retries at the next cadence. Evidence-read and sink failures still enter one visible degraded episode. The reviewer never starts a Herdr agent or selects a substitute model.

For a long `herdr_wait`, an active bound supervisor with the complete exact target identity is the sole semantic-review owner for that child. Covered targets are omitted from the explicit wait reviewer; only unsupervised targets receive the existing concurrent low-thinking reviewer. Coverage is recomputed after each authoritative target observation at every cadence. A degraded but live supervisor keeps ownership, and the wait reviewer is never a hidden fallback. All-covered waits construct no wait reviewer. The typed `JobDetail.semanticReview` projection records the latest covered and explicit target partition independently from truncatable progress. A reviewer `unknown` is suppressed only when a fresh exact post-review agent read proves the same occupant is `working`; output metadata alone is insufficient, and missing, malformed, timed-out, contradictory, or non-working reads retain manager-judgment behavior.

**Wake delivery.** Wakes are report-only, best effort, and never retried. The Pi extension host delivers through the existing `sendMessage` custom-context path with `deliverAs: "steer"` and `triggerTurn: true`. The MCP host routes each wake by the hosting pane's own agent kind, resolved lazily on the first delivery and cached for the session: `devin` and `pi` hosts self-prompt the manager pane through `agent.prompt`, carrying the full identity sandwich — `kind: supervision` for supervisor events and `kind: wait` for settled `herdr_wait` jobs — with the acknowledgement validated by `parsePromptSubmission`; `claude` hosts send the `notifications/claude/channel` notification only, with no prompt fallback. Before the identity join, a `devin`, `pi`, or `claude` host whose own pane is detected but unnamed — the agent name is the sole missing join field — performs lazy self-adoption once per session through the shared `adoptUnnamedTarget` helper: it mints `<kind>-<normalized paneId>` through `agent rename`, retries `agent_name_taken` with suffixes `-2` through `-9`, and re-verifies the minted name through the standard prompt-target join before any bytes are sent. The outcome is memoized: a minted name or permanent refusal is never re-attempted, while a transient read or rename failure clears the memo so the next wake retries. A pane already named by hand, a pane missing any other identity field, and unsupported kinds skip the attempt entirely; every other kind, or an own-pane kind that cannot be proven, is inert. The gate is sendable-state only: a `working` or `blocked` manager still receives the wake while `unknown` or unproven state drops it. On `devin`, a write acknowledged while the pane was `working`/`blocked` lands in the composer's queued input — `○`-prefixed gray rows above the input box plus an all-placeholder send-queued hint — which does not drain at turn end on its own; the pipeline then runs a bounded flush cycle — `agent wait` for `idle`/`done` with a timeout strictly inside the cycle's abort budget, which starts when the cycle starts — and sends an `enter` key only while an ANSI composer read proves queue evidence inside the composer box (a `○` row, the word "queued" in the box's section, or the placeholder hint — never in scrollback) above an all-placeholder input area and a fresh `pane get` still shows `idle`/`done`. One Enter drains the whole queue, so a second press requires an observed change to the box interior (an identical re-read is repaint lag), with at most two Enters per cycle. Cycles serialize: wakes acknowledged while the latest cycle still waits join its drain, later ones append a fresh cycle with its own budget, and `shutdown()` aborts the session signal shared by the whole pipeline — identity reads, the `agent.prompt` write, and the flush — so none can fire after the server closes. This completes the acknowledged send rather than retrying it. Pi steers the same write into the running turn, so no flush follows it. The self-prompt targets the server's own hosting pane by design — the communicate tool's self-target refusal is a tool-call policy, and the socket has no such rule. Compiled contracts emit no `developmentChannels` entries, so no `--dangerously-load-development-channels` opt-in reaches a Claude launch. Wakes missed on any host are recovered by `herdr_jobs` polling, which returns pending events by opaque ID and marks exactly those observed.

**Soft receipts.** Every material event carries an opaque `eventId`. `herdr_jobs get` returns the pending unobserved events and marks exactly those observed; `list` and the Pi active-job UI show unobserved counts. Event, transition, reviewer, and reconciliation history are bounded with explicit truncation counts. Nothing is resent.

**Lifecycle.** Supervisors are session-scoped and never persist across manager sessions. Manager-session shutdown cancels them, and a new session begins a new supervision session with a fresh monitor, because a stopped monitor stays stopped. Exact-child termination settles them. `herdr_jobs cancel` is refused with `SUPERVISION_ACTIVE` while an exact or provisional child is live.

### `herdr_launch`

**Purpose:** Launch exactly one caller-authored **Task** per call as supervised Herdr children and return the uniform launch result. The Task's four semantic fields — `objective`, `scope`, `doneWhen`, `constraints` — are the single work contract: the same values feed deterministic child instruction rendering, Jev evaluation, caller-required resource checks, supervision reservation and review, and bounded decision evidence. Runtime owns identity, topology, delivery, supervision, and evidence. **Specs, categories, assignments, profiles, roles, caller naming, caller placement, caller delivery, overrides, and request-level supervision digests no longer exist** — the strict schema rejects every undeclared field with no compatibility alias. Raw `kind`, `argv`, and `env` launch fields are likewise rejected: the compiled contract, not the caller, supplies runtime configuration.

**Input:** one strict object (`LaunchTaskSchema` in `src/launch-schema.ts`). Unknown fields fail validation. Text fields are nonempty and reject NUL.

```text
{
  objective: string,          // required — what the child must achieve
  scope: string,              // required — what the child may and may not change
  doneWhen: string[],         // required; 1..8 concrete falsifiable conditions
  constraints?: string[],     // optional; 0..8 entries, default [] — caller constraints beyond the universal baseline
  tier?: QualityTier,         // optional; utility|economy|standard|strong|frontier|max, default "standard"
  replicas?: integer,         // optional; 1..8, default 1 — identical Task replicas over isolated worktrees
  recoveryOf?: string,        // optional; managed handoff run ID of a failed child
  label?: string,             // optional; display metadata only
  cwd?: string                // optional; any accessible directory, canonicalized before effects
}
```

These former public fields are deleted and rejected without alias: `name`, `specs`, `tasks`, `instructions`, `assignment`, `supervisionDigest`, `category`, `count`, `placement`, `focus`, `assignmentDelivery`, workload overrides, `transportBypass`, `profile`, `overrides`, `kind`, `argv`, `env`. In-flight and historical records retain their original representation and are never passed through the new parser.

`label` is presentation metadata: it may be repeated and never affects routing, Jev state, Task revision, machine identity, tab selection, or target resolution. `constraints: []` means no caller-specific constraints beyond the universal baseline — a separate trusted system block that owns platform conduct (single-writer behavior, contract preservation, evidence reporting, delegation limits, handoff obligations); callers do not repeat those rules. Task size has exactly one authority — the UTF-8 byte length of the *rendered* Task checked against the delivery bound at runtime — so no per-field `maxLength` exists.

#### Routing and admission

Every launch passes this pipeline before any launch effect. All of it completes before the first topology mutation:

- **Catalog.** `herdr-profiles/catalog.yaml` under the trusted manager/session project root is loaded once per request. The v2 catalog carries runner entries for `pi`, `claude`, `agy`, and `devin` — each generating its reviewed model set by runner-supported reasoning-setting cross product into exact **operating points**, one point per runner/model/reasoning combination — plus reviewed resource `pools`, the top-level `skills`/`plugins`/`mcp` reviewed sets, and `quotaSources`. Every exact point carries reviewed `{costClass: low|medium|high|extreme, latencyClass: low|medium|high|extreme}` metadata; missing or duplicate metadata invalidates the catalog. A catalog that cannot be loaded or parsed abstains for the request; entries are never invented. An operating point has no intrinsic quality tier.
- **Evaluation.** One `systemOne` request per Task through `TypeSafeSpecClient` (model `jev-latest`; the credential resolves through `resolveTypesafeApiKey` — the `TYPESAFE_API_KEY` environment variable first, then the `typesafe` `api_key` entry in the Pi auth store). The request carries the raw canonical Task, the requested tier, runtime state, reviewed operating-point metadata, and catalog resource projections, and asks: `done_when_verifiable` — the only semantic launch-quality gate, judging whether `doneWhen` contains concrete, falsifiable completion evidence relevant to `objective` and `scope`; six closed workload choices — `intent`, `mutation`, `scope`, `horizon`, `verifiability`, `ambiguity` (`workspaceState` is runtime-derived from lifecycle and handoff evidence, never caller prose); runner-qualified resource Nouls; and six tier-specific fitness Nouls for every statically admissible operating point, so post-policy tier selection never needs a second model call. There are no retries, repairs, or model-listing calls; malformed, unauthenticated, or failed evaluation becomes a typed abstention. A confident bad gate answer rejects the Task; a passing answer records `not_rejected`, never a certification. Fitness is a ranking signal, not an admission gate.
- **Tier policy.** A quality tier is the caller's requested starting quality/compute posture (`utility < economy < standard < strong < frontier < max`; omission means `standard`). Intent supplies a base floor/ceiling interval (`explore` utility–standard, `reason` economy–frontier, `implement`/`review`/`coordinate` standard–frontier, `debug` standard–max, `verify` utility–standard); each difficult modifier — `mutation=broad`, `scope=repo_wide`, `horizon=long`, `ambiguity=high`, `workspaceState=partial|failed` — adds one tier to the floor, capped at `max`. Any difficult modifier raises the recovery ceiling one tier; `workspaceState=failed` raises it to `max`. A requested tier below the floor is raised automatically; if the floor or requested tier exceeds the ceiling, the effective ceiling rises to the effective start. Tier envelopes bound admissible points: `utility` low/low, `economy` low/medium, `standard` medium/medium, `strong` high/high, `frontier` extreme/extreme, `max` unbounded. A workload choice below 0.8 confidence abstains before topology or launch effects, naming the uncertain dimensions — there is no classification receipt and no public workload override.
- **Deterministic authority.** Code, not Jev, assembles the decision: reviewed model/reasoning membership, runner compatibility, authorization and account eligibility, capability/resource-pool/permission/execution-policy limits, tier envelopes, workload floor/ceiling calculation, recovery lineage and exclusions, dynamic availability filtering, and the four-attempt fallback bound. The compiler remains the final security and capability authority. The fallback chain contains points from the effective start tier only — it never widens into a stronger tier — ordered by highest-fitness available point, providers not already represented, remaining points by fitness, then stable `operatingPointId` tie-break. The initial availability filter runs after fitness scoring and is **rechecked immediately before every start attempt** across the whole fallback loop; a point that becomes unavailable is skipped without another Jev request. An empty effective tier abstains `no_candidates_at_tier`. Typed abstentions produce zero launch effects: no topology, start, prompt, handoff, recipient, or supervision effect occurs.
- **Compilation.** The selected point compiles through `compileCandidateContract` into the runner's effective argv-level configuration: Jev's resource picks intersected with the reviewed pool and never widened — a name outside the pool is `SELECTION_OUTSIDE_POOL`, a point outside the runner's reviewed model set is `CANDIDATE_NOT_REVIEWED`, an empty permit set argv cannot express is `EMPTY_PERMIT_SET` — plus declared dependencies added, incompatible pairs removed, and deny-channel rules derived, each step recorded as a `derivation`. The contract records installed/selected/exposed/permitted/denied sets per pool field and records `deny-coverage` and `ambient-exposure` gaps rather than dropping them. Pi compiles `--tools`/`--extension`/`--skill` selections (with unconditional `--no-skills`, so the exposed set is exact); Claude compiles `--allowed-tools`/`--disallowed-tools`/`--plugin-dir`; AGY and Devin consume no pool fields — their resources are ambient by mechanism. Compile failures surface as typed abstentions, never partial contracts.
- **Decision log.** Exactly one fixed-schema JSONL record per Task decision is appended at `.herdr/router/decisions.jsonl` under the trusted root — never a caller-controlled child `cwd` — after the decision and before any child mutation. The record carries bounded non-secret evidence: requested tier, workload floor, effective start and ceiling, workload choices with probabilities and confidence, consumed fitness judgments, operating-point metadata and deterministic exclusions, the generated chain and selected point, availability and recovery evidence, and catalog/policy revisions. Caller text, resource bodies, credentials, raw provider responses, and exception messages remain excluded. Appends serialize on the `decisions.lock` flock into owner-only directories and a `0600` append-only file. A failed append is a typed `ROUTER_LOG_UNAVAILABLE` failure result: zero children launch.


#### Catalog pools and ambient resources

The reviewed pools cover only resources intentionally promoted for operating-point compilation — Pi `--skill`/`--extension`/`--tools` units, Claude `--plugin-dir` roots, and the MCP servers those plugins provide. The catalog-vs-disk inventory (`.herdr/artifacts/resource-mapping/skills-extensions.md`) reconciles every installed skill and extension against the pools: 41 installed entries are present on disk but absent from the catalog pools — ambient Pi extensions (`herdr-agent-state`, `herdr-question-alert`, `herdr-tools`, `tmux-bg-notify`), ambient `/home/gabriel/.agents/skills` skills, Pi skills installed outside the catalog, and host-provided plugin entries. These are host-provided ambient resources, **not** point-selectable resources; their absence from pools is by design unless the owner promotes them into the reviewed catalog. The same inventory reports 0 catalog declarations missing on disk — all 47 unique skill declarations and all 8 extension/plugin declarations resolve to installed paths.

#### Runtime topology, naming, and replicas

Each admitted Task expands to `replicas` children under runtime-owned identity and topology:

- Child names are minted by the runtime as `task-<launchId-8>-<ordinal>` — never caller-chosen — and remain exact targets for `herdr_wait`, `herdr_communicate`, and close. Fallback along the operating-point chain never renames a child.
- Topology is the workload-tab grammar (ADR-037 D12): `workload:<intent>` is the first tab of a classified intent and `workload:<intent>:<n>` its numbered spillovers. Launch reuses the matching tab in the caller's workspace while it still holds fewer than four panes, otherwise creates the next grammar label; panes are created by right-split only, always `--no-focus`, in the launch cwd. Existing panes are never closed, replaced, or moved, and a reused tab's internal layout is recorded as unverified.
- `replicas <= 1` is a pass-through: the child launches in the canonicalized `cwd` with no worktree effects. `replicas > 1` gives each replica an isolated detached-HEAD worktree at `<repo>/.herdr/worktrees/<childName>` with a provenance marker at `.herdr/worktrees/.meta/<childName>.json`; creation serializes on `.herdr/worktrees/creation.lock`, directories are created owner-only and proven trusted, and a same-name stale directory is reclaimed only when its marker proves ownership. Replica worktrees are ephemeral writers — the universal baseline requires leaving deliverable work uncommitted.
- Children dispatch strictly one at a time through the shared lifecycle — mutating topology and start calls are never raced — while already-launched children work concurrently; sequential start is not a fan-out cap. Each child re-acquires the launch gate, re-checks freeze and caller abort, and re-runs its identity checks on a fresh authoritative snapshot.

#### Per-child launch lifecycle

These rules are the single launch lifecycle; every dispatched child runs it independently under its own compiled contract.

- Each child runs under its runtime-minted `task-<launchId-8>-<ordinal>` name — no caller naming, derivation, or collision reservation exists. Topology is the workload-tab grammar: the classified intent's matching tab is reused under the four-pane cap or the next `workload:<intent>:<n>` label is created, and the child pane is a right-split in that tab, always `--no-focus`, in the launch cwd.
- For Pi and Claude the rendered Task instructions — the universal baseline followed by the provenance envelope carrying the rendered Task (`src/spec-baseline.ts`) — are materialized to a prompt file before topology mutation and appended through the runner's existing system-prompt channel (`--append-system-prompt` / `--append-system-prompt-file`). AGY and Devin accept no prompt file: they discover repository `AGENTS.md` natively and require one visible, self-contained, provenance-wrapped Task delivered through the prompt channel. Immediately before each `agent start` invocation, launch records a monotonic start-budget basis. When that attempt is selected, one condition-based, read-only readiness loop uses the remainder of the same absolute 120,000 ms startup budget; start return, sampling, and polling never reset it. Every sample is a fresh ordered `api snapshot` → `agent get` → `pane get` sequence and is evaluated only after all three reads complete, using that sample plus identity fields actually supplied by the selected `agent_started` record. No record or field carries across samples. Fixed-whitelist model-visible evidence resets before each sample, then retains each completed current-sample read; if pane-get fails, the completed snapshot and agent-get projections remain available without evaluating readiness. Duplicate target records, malformed non-null metadata, contradictory identity aliases, or replacement evidence is terminal. Missing/null noncontradictory startup metadata is pending only inside readiness. Every non-null lifecycle field from start or sample records is shape-validated: known `agent_status`, safe non-negative `state_change_seq`/`revision`, and boolean diagnostic `screen_detection_skipped`. Valid start lifecycle values are earlier process-start observations and are never merged into or compared with a later sample. Every launch carries the canonical Task, so every launch requires the idle lifecycle baseline and lifecycle agreement below, and no promptless launch path exists. The Task is validated by `LaunchTaskSchema` — exact field set, nonempty NUL-free text, bounded `doneWhen`/`constraints` — before mutation, reservation, attachment publication, or any CLI call. `renderTask` then renders it once in a fixed field order with fixed labels, so the same Task always renders byte-identically, and the rendered payload's UTF-8 byte length is the single authority for the delivery bound. No AGY fallback is pruned from a launchable chain, because no child can be started without its Task.
- Before a Pi or Claude initial prompt is submitted, the same readiness sample's authoritative `agent get` record must independently contain the full exact captured pane/terminal/name/kind/agent_session identity, exact idle state, and safe non-negative `state_change_seq` and `revision`. Same-sample snapshot-agent, snapshot-pane, and pane-get lifecycle fields must agree with this anchor when they supply a non-null value but cannot fill any anchor omission. Valid same-identity lifecycle disagreement is sequential transition/skew: the sample stays pending, is discarded, and is resampled without field merging or prompt submission. Valid non-idle anchor state and missing/null fields remain pending within the absolute startup budget; malformed lifecycle shapes, duplicates, identity contradictions, and replacement are terminal. Readiness returns this identity and baseline together, and launch performs no later one-shot baseline read. Phase remains `ready` throughout sampling, changes to `prompt_verification` immediately before stdin submission.
- The rendered Task prompt is wrapped in the mandatory visible v1 envelope and submitted exactly once through `agent prompt --stdin` without `--wait`. For Pi and Claude, a parsed `cli:agent:prompt` / `agent_prompted` response must match the exact captured identity. For provisional AGY, it must match the captured pane, terminal, name, and kind. All runtimes require interactivity proof and a safe revision: `interactive_ready:true` is the managed proof; when the flag is absent, a known live `agent_status` of `idle`, `working`, `blocked`, or `done` with `launch_pending` absent or `false` is the detection proof, while `interactive_ready:false`, any other `launch_pending` value, `agent_status:"unknown"`, and a missing lifecycle status are terminal. Launch then runs a separate bounded 5,000 ms read-only confirmation loop at 100 ms cadence; this window neither reuses nor extends startup readiness. Every sample performs sequential `agent get` and pane reads under one shared cancellation window and carries no record from an earlier sample. Agent-get is the sole coherent source of status, sequence, and revision; pane-get proves identity continuity only, and lifecycle fields are never merged across records. `working`, `idle`, `blocked`, or `done` confirms only when the agent-get sequence strictly exceeds the baseline and its present revision has not regressed from the baseline or acknowledgement. Unknown, missing fields, unchanged/regressed sequence, missing/regressed revision, and same-identity transient skew remain unconfirmed until the deadline. `screen_detection_skipped` is bounded diagnostic metadata only and never validates, confirms, contradicts, or rejects.
- Replacement, disappearance, contradiction, read failure, timeout, or caller abort after acknowledgement fails closed as `PROMPT_UNCONFIRMED` — preserved as the child's error code rather than collapsed to `LAUNCH_FAILED` — with `causeCode:"PROMPT_UNCONFIRMED"`, the retained `paneId`/`supervisorJobId` recovery handles, `phase:"prompt_verification"`, `promptSubmitted:true`, `promptConsumption:"unconfirmed"`, bounded acknowledgement/submission evidence, baseline and last sequence/revision/state, sample count/timing, reason/source code, and created resource IDs. `PROMPT_UNCONFIRMED` means not proven, possibly consumed. Tools-only telemetry can false-negative a valid fast turn; this deliberate availability trade-off never authorizes retry, cleanup, recipient registration, or dependent assertions. A confirmed prompt reports `promptSubmitted:true`, `promptConsumption:"confirmed"`, and final observation/confirmation evidence. The prompt-confirmation phase never sends recovery Enter, invokes a runtime hook, invokes or retries prompt/start, falls back after submission, duplicates prompt bytes, or automatically cleans partial resources; the typed pre-prompt start-fallback contract remains unchanged.
- Recipient registration occurs only after semantic prompt confirmation succeeds. AGY recipient and attachment capability registration additionally requires successful exact-session strengthening and exact job publication. Registrations persist pane ID, terminal ID, agent name, agent kind, and the complete session object; optional `agent_id` is diagnostic only and never authorizes attachment delivery.
- Only exhaustion of the readiness loop's absolute deadline fails the child with `READY_TIMEOUT`; an individual readiness-read `CLI_TIMEOUT` remains `LAUNCH_FAILED` with `causeCode:"CLI_TIMEOUT"`. A readiness timeout or caller abort after successful start preserves partial effects with evidence `agentStarted:true`, `promptSubmitted:false`, `recipientRegistered:false`, created IDs, start-budget basis/elapsed time, sample count, last pending reason, fixed-whitelist bounded records, and `baselineRequired`. Grant-path and published-attachment evidence is retained. It performs no fallback, retry, cleanup, generated Enter, focus mutation, prompt submission, or recipient registration. Malformed, duplicate, identity-contradictory, and replacement failures preserve the same effect boundary.
- Each Herdr start attempt uses one absolute valid 120000 ms start-plus-readiness budget, while the CLI subprocess receives a small execution margin; the runner's catalog `timeoutMinutes` default is task policy carried by the compiled contract, not the start budget.
- AGY argv is fixed to `--model <model> --mode <mode> --dangerously-skip-permissions`, where `model` and `mode` come from the compiled contract (the runner's catalog defaults), followed by the Herdr-Tools-owned recipient attachment directory, then the final `--prompt-interactive "Initialize this interactive session and reply with exactly AGY_READY."` bootstrap. This fixed non-sensitive bootstrap establishes the native session before the real Task prompt, which remains exclusively in the later provenance-wrapped `agent prompt --stdin` input. AGY accepts no prompt file, `--agent`, arbitrary argv, arbitrary env, or non-persistent session mode.
- Automatic fallback is permitted only for a proven pre-spawn start failure — the installed CLI failure envelope `{id:"cli:agent:start",error:{code:"agent_start_failed",message:"agent process exited before becoming interactive"}}` with non-killed exit 1 and untruncated stderr, a quota-classified start failure, or a killed `CLI_TIMEOUT` start — followed by an authoritative pane read proving no agent occupies the pane. Timeout, malformed/protocol, identity/kind, prompt, and uncertain-state failures stop without fallback.
- Fallback stays inside `agent_start`, before supervision binding and before prompt delivery. The Task's deterministic fallback chain — operating points from the effective start tier only, bounded at four attempts — is tried in order under each point's own compiled contract, with availability re-probed immediately before every `agent start` invocation and no second Jev request; fallback can change the runner and model that actually start the child, and it reuses the resolved pane. An exhausted chain fails the child and reports bounded attempt evidence; no point is improvised. There is no post-spawn fallback.
- Launch details report the Task evidence — requested tier, workload floor, effective start and ceiling — the selected operating point and the full fallback chain, effective runtime/model/timeout/permissions, bounded attempt evidence, readiness timing/records, authoritative IDs/post-state, prompt submission/observation evidence, and any visible provenance. They include independent monotonic safe-integer durations for selected start through readiness, immediately before stdin submission through completion of typed acknowledgement parsing and identity validation, and validated acknowledgement through semantic confirmation; observed durations are never clamped to their configured maxima. Readiness diagnostics use a four-record fixed-whitelist projector: only fixed identity/lifecycle keys, bounded primitive values and malformed/missing markers, plus the four fixed agent-session fields survive. Arbitrary keys, nested trees, arrays, prototype-shaped properties, and oversized values cannot enter readiness records or readiness error metadata. Failed launches retain created resources and never auto-clean them. When a typed CLI failure reaches the launch boundary, argv calls retain bounded fixed-shape stdout/stderr evidence; stdin deliveries retain only non-textual stream presence/size/truncation. Raw stdin stdout/stderr and prompt bodies are never retained or published.

#### Results and public projections

- Every request returns the uniform `launch` result (`LaunchResult`): `launchId`, `outcome` one of `launched | abstained | partial | failed`, the `requestedTier` and `effectiveTier`, one entry per expanded child — the runtime-minted `target` (also the pane/agent target), `state` (`launched | failed | not_started`), the exact `operatingPointId` that started it, `supervisorJobId`, `worktree` when a replica ran in one, and a bounded `{code, message}` failure fact — plus an optional top-level `error`. `abstained` is the explicit zero-effect result with `children: []`; `launched` means every expanded child confirmed its launch; `failed` means no child confirmed a launch; `partial` retains mixed outcomes without rollback. A caller abort stops dispatch, retains completed and in-flight evidence, and marks every undispatched child `not_started`/`ABORTED`; there is no close, rollback, resubmission, or retry of uncertain effects, and a request is never retried as a whole after partial effects. Outcomes are structured results rather than thrown errors: request validation and the pre-routing freeze gate still fail through the typed error mechanism, while every outcome decided after routing begins carries its evidence inside the result. Pane identity resolves through the supervisor job named by `supervisorJobId`, not through the result itself.
- The result content leads with a compact all-child manifest — a head line carrying the outcome, launch ID, tiers, child count, and any whole-request failure code, then one line per expanded child with its target, state, operating point, supervisor job, worktree, and failure code — before the verbose details, so a bounded response can never masquerade as a smaller launch. Structured details keep the full per-child evidence and degrade through the existing explicit truncation envelope (`truncated: true`) at the 60,000-byte MCP result bound; no cap, fabricated success, dropped tail child, or new stored resource is introduced to fit.
- **Public job projection.** The `herdr_jobs` supervision view exposes `operatingPointId` — the exact operating point that bound and started the child — under `request.child`, `supervision.child`, and `supervision.provisional`. When fallback changed which point started the child, `requestedOperatingPointId` carries the point recorded at reservation; it is omitted when the two are equal. Consumers that read the retired `candidateName`/`requestedCandidateName`/`profileName`/`requestedProfileName` fields must update.
- **Caller policy.** ADR-030 is unchanged: `herdr_launch` stays unscoped for every caller, and the `herdr_communicate` leaf restriction is not an admission gate. Orchestrator provenance is stamped from the bound operating point the launcher actually started.

### Run handoff artifact

ADR-031 defines a Tools-owned orchestration gate. It does not prevent Herdr core from reporting a raw terminal state.

- Each launch receives one generated run UUID and one run-owned path under the endpoint-private Herdr Tools state namespace. Callers cannot select the path.
- The Markdown record has exactly `Status`, `Summary`, `Changes`, `Verification`, `Blockers`, and `Continuation`; status is `done`, `blocked`, `cancelled`, or `failed`; `Changes` is a path list or `None`. Missing, empty, duplicate, extra, placeholder, foreign-run, or stale-cycle content is invalid.
- Validation rejects traversal, symlinks, non-regular files, wrong ownership or unsafe modes, and oversized input. Handoff evidence is independent from raw `agent_status`.
- For an authoritatively identified managed run, `completed` matches neither `idle` nor `done` until the current handoff validates. `terminal` likewise remains unmatched for every terminal outcome until a current artifact with the corresponding status validates. Validation occurs in asynchronous per-target readers before `any` or `all` aggregation, so one invalid target cannot starve a valid sibling. Identityless non-strict waits remain observation-only and explicitly ungated.
- Turn-level Escape, cancel, or interrupt does not cancel the run. A runtime-authored `cancelled` fallback requires confirmed run-level cancellation or authoritative exit. Async settlement persists required fallback evidence first; pre-bind release is launcher cleanup; host shutdown fabricates nothing and leaves unresolved state `recovery_pending`.
- Restart restoration is deferred. The versioned sidecar reserves exact identity, lifecycle watermark, and repair-fence fields, but a new host may re-prompt once for the same artifact version until restoration ships.
- Retention lasts only as long as the endpoint-private state namespace. Same-UID agents are cooperative rather than hostile isolation, and no fallback can be guaranteed if every monitor dies before persistence. No database, daemon, watcher, transcript scraping, caller path, or per-candidate static instruction is introduced.

### `herdr_pane`

**Execution:** This mutating tool is registered with `executionMode: "sequential"` across all pane operations, including close.

**Purpose:** Perform pane topology mutations — split, move, rename, focus, resize, swap, zoom, close — plus `adopt`, an identity-registry mutation that binds an agent name to a detected pane Herdr did not launch.

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

{
  operation: "adopt",
  target: TargetRef,
  name: AgentName                             // ^[a-z][a-z0-9_-]{0,31}$ (launch name grammar)
}
```

Rules:

- `adopt` binds an agent name to a detected pane Herdr did not launch. The target resolves through the authoritative snapshot; adoption requires exactly one agent record for the pane, a complete `agent_session`, a `terminal_id`, a known non-`unknown` `agent_status`, and at most one existing agent name. It is idempotent when the pane already carries the requested name, refuses a different existing name with `AGENT_ALREADY_NAMED`, and refuses a name another pane already holds with `AGENT_NAME_TAKEN` — checked against the snapshot before dispatch and mapped from a server-side `agent_name_taken` race. After `agent rename` mints the name, a fresh snapshot plus agent/pane reads must pass the standard prompt-target identity join, and the verified name must equal the requested name; a contradictory or changed post-mint identity fails closed as `TARGET_IDENTITY_CHANGED`/`TARGET_IDENTITY_UNAVAILABLE`. Details return the compact verified identity plus `namePreexisting` on an idempotent adopt. Names bind to panes, not sessions: a coherent session rotation in the same pane still verifies, and consumers needing session pinning must inspect `agent_session.value`. Adoption never renames the pane label — labels are UI furniture while agent names are routing identity.
- Successful adopts and successful launches write best-effort advisory provenance tokens (`identity_provenance=adopted` or `=launched`, plus `identity_actor` and `identity_session`) through `pane report-metadata`. Manager and planner launches additionally write `identity_scope=orchestrator`, so a delegated orchestration seat is unrestricted before it launches its first lane. The tokens are forgeable shared metadata — any source can overwrite them — so they are never consulted for authorization or identity proof. ADR-030 ratifies one cooperative exception: the tokens may drive the caller-policy routing restriction on `herdr_communicate`, which is fail-closed convenience routing for honest agents, not a security boundary. A failed write surfaces as `provenanceWarning` rather than failing the operation.
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
    "reviewerModel": "openai-codex/gpt-6-sol"
  }
}
```

- `wait.reviewCadenceMinutes`: integer, default `5`, inclusive range `1..30`.
- `wait.reviewerModel`: model identifier, default `openai-codex/gpt-6-sol`.
- Reviewer thinking level is fixed to `low` and is not configurable by a tool call.
- `wait.reviewCadenceMinutes` is shared with the supervision reviewer. `wait.reviewerModel` is wait-only: the supervisor reviewer's model is the code constant `SUPERVISION_REVIEWER_MODEL` (`typesafe/jev-latest`), not a setting, and Jev carries no thinking level.

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
- `SELF_TARGET_REJECTED`: inter-agent communication targeted the caller's own pane; no text was sent.
- `SENDER_IDENTITY_UNAVAILABLE`: the caller pane was absent from the fresh authoritative snapshot; no text was sent.
- `CALLER_POLICY_UNAVAILABLE`: caller-policy provenance evidence was absent, malformed, or contradictory; classification never guesses, so the send or turn-control call fails closed before any dispatch.
- `CALLER_BINDING_UNAVAILABLE`: a launched leaf worker's manager binding was missing, self-referential, or stale; no text was sent.
- `TARGET_SCOPE_REJECTED`: a launched leaf worker targeted a pane other than its recorded `identity_actor`, or attempted `keys`, `cancel`, or `interrupt`; no bytes were sent.
- `TARGET_STATE_UNKNOWN`: authoritative target state is explicitly unknown; no prompt or key bytes were sent.
- `TARGET_STATE_UNAVAILABLE`: authoritative target state is malformed or unavailable; no prompt or key bytes were sent.
- `KEY_REJECTED`: key is not a supported named key.
- `POSTSTATE_UNAVAILABLE`: mutation completed or may have completed, but authoritative post-state could not be read.
- `LAUNCH_FAILED`: launch failed; any created resources remain.
- `PROMPT_UNCONFIRMED`: one launch initial prompt was acknowledged as submitted, but same-agent semantic consumption was not proven within the bounded confirmation contract. It means **not proven, possibly consumed**, appears as the `causeCode` of `LAUNCH_FAILED`, retains the active supervisor plus exact pane and supervisor job IDs for recovery, and never authorizes an automatic Enter, retry, cleanup, recipient registration, or dependent work.
- `READY_TIMEOUT`: the selected start attempt's absolute launch-readiness deadline was exhausted. It is never inferred from a phase name or an individual `CLI_TIMEOUT`.
- `ROUTER_LOG_UNAVAILABLE`: a Task decision could not be appended to the local decision log; the request launches zero children and retains the decision in the failure evidence.
- `BATCH_PLACEMENT_INVALID`: retained failure-classification entry for historical records; ADR-037 deleted caller placement, so no new launch emits it.
- `BATCH_NAME_COLLISION`: retained failure-classification entry for historical records; runtime-minted child names carry no derivation or collision check.
- `BATCH_CHILD_NAME_INVALID`: retained failure-classification entry for historical records; minted names are always valid by construction.
- `BATCH_ROUTE_EMPTY`: retained failure-classification entry for historical records; a Task always expands to `replicas` children.
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
- `ADOPT_TARGET_UNQUALIFIED`: an adopt target lacks exactly one agent record, a complete `agent_session`, a `terminal_id`, or a known non-`unknown` `agent_status`; no name was minted.
- `AGENT_ALREADY_NAMED`: the adopt target already carries a different agent name; no name was minted.
- `AGENT_NAME_TAKEN`: the requested or derived agent name is held by another pane, found in the snapshot or raced server-side.
- `CANCEL_UNCONFIRMED`: one Escape was dispatched but cancel was not proven; target disappearance is never cancel success.
- `INTERRUPT_UNCONFIRMED`: one Ctrl-C was dispatched but same-agent termination or the strict agent-exited proof was not established.

A detached `herdr_wait` timeout is a normal structured job result with `matched: false`, not `CLI_TIMEOUT`. No error path may substitute a guessed ID, focused pane, fallback model, generic success, or automatic cleanup.

## Security and safety boundaries

- The extension is global code with full Pi permissions; it is trusted code and must remain narrowly scoped.
- Registration is gated by `HERDR_ENV=1`.
- All process execution uses `pi.exec` with explicit executable and argument arrays. No shell interpolation, command concatenation, arbitrary executable input, or direct socket protocol implementation is allowed.
- `herdr_launch` accepts only the strict Task request; every admitted child runs a contract compiled for a reviewed operating point — Jev may narrow a pool, never widen it — and raw kind, argv, env, `profile`, and `overrides` fields are rejected at validation.
- AGY alone accepts provisional pane, terminal, name, and kind continuity before the first prompt. That continuity is not cryptographic attribution. A same-terminal, same-kind replacement or stale pane-scoped report can be misattributed until exact native-session strengthening. This reduced-assurance risk is bounded by the five-second confirmation window and lifecycle advancement requirement. Pi and Claude remain strict before prompt delivery.
- First-class AGY support is implemented only in Herdr Tools. It requires no Herdr Core or AGY CLI change.
- Target resolution is exact and fail-closed. The extension never relies on UI focus or guesses an ID.
- Named keys are lower-level validated symbols rather than caller-supplied raw bytes. The existing `esc`, `escape`, and `ctrl+c` escape hatch remains available and is not routed through semantic turn control; key delivery does not add a second confirmation dialog.
- The caller-policy restriction on `herdr_communicate` (ADR-030) is cooperative routing, not authorization. Identity tokens are forgeable shared metadata, and any caller with raw CLI or terminal access bypasses the guard; the restriction exists so honest workers route results to their recorded manager and cannot accidentally drive other panes.
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
- `herdr_launch` streams bounded progress through `onUpdate` for supervision reservation, placement, readiness, supervision binding, and prompt verification. Binding precedes prompt dispatch. A multi-child call streams each dispatched child's lifecycle progress labeled with that child's exact name, and its result leads with the compact all-child manifest before verbose details. A supervisor stores bounded transition, reviewer, reconciliation, and event progress on its own job for `herdr_jobs` inspection. `herdr_wait` stores bounded target-state, semantic-review ownership, and reviewer progress on the detached job for `herdr_jobs` inspection instead of using the initiating update callback.
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
│   │   ├── reviewer.ts              # Jev supervisor review (SUPERVISION_REVIEWER_MODEL)
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
- normal prompt submission to working and blocked targets through the steer path;
- explicit steer submission to idle/done/blocked/working targets with zero interrupt-key calls;
- named-key validation without confirmation;
- strict cancel/interrupt variants, snapshot plus fresh-agent identity binding, complete-string identity prefix-collision replacements, independently validated flattened session alias families, exactly-one-key dispatch, fixed wait/final-snapshot sequencing, abort races, state-change confirmation, duplicate-record rejection, disappearance and agent-exited rules, stable errors, bounded evidence, redaction, compact rendering, MCP parity/FIFO, and exact negative disposable integration;
- wait state semantics, literal/regex matching, any/all, immediate matches, bounded timeout final snapshots, abort, and internal CLI failures;
- every long-wait reviewer rule, including exact supervisor coverage, concurrent one-per-unsupervised-target calls, lazy reviewer construction, bounded deltas, no tools, `unknown` post-review proof, manager-judgment early exit, and immediate reviewer failure;
- runtime-minted launch names, the strict Task launch schema, startup-timeout margins, real failure-envelope fallback, AgentInfo correlation, selected-attempt absolute readiness budgeting, ordered coherent samples with no cross-sample carry, current-sample snapshot/agent evidence retained across a pane-read failure without early readiness evaluation, lifecycle shape validation for prompt/readiness/start records, start-lifecycle time separation, pending same-identity lifecycle skew without field merging/submission, explicit `READY_TIMEOUT`, pending missing/null metadata, terminal malformed/duplicate/replacement evidence, same-sample authoritative idle baselines, advanced-sequence plus non-regressed-revision confirmation for every state, unchanged/regressed/missing counters, cross-record lifecycle skew, screen-flag diagnostics, fixed-whitelist readiness records/error metadata rejecting arbitrary keys, nested trees, arrays, prototype-shaped properties, and oversized values, readiness CLI failure preservation, readiness and post-ack abort partial effects, exactly one submission, no failed recipient registration, bounded `PROMPT_UNCONFIRMED` evidence, and failed-launch retention;
- the Task launch schema and its per-Task `systemOne` evaluations, `done_when_verifiable` quality gating and workload-choice `ROUTER_CONFIDENCE_THRESHOLD` (0.8) confidence abstention, tier floor/ceiling envelopes, deterministic same-tier fallback chains with per-attempt availability re-probe, availability pre-filtering with typed abstention zero launch effects, exactly one decision-log append before the first child mutation, `ROUTER_LOG_UNAVAILABLE` stopping all children, sequential per-child dispatch with full evidence and runtime-minted `task-<launchId-8>-<ordinal>` names, workload-tab topology selection, the abort `not_started` tail, no rollback after partial effects, and the complete all-child manifest under host truncation;
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
   - Acceptance: state/output conditions, any/all, explicit timeout, timeout snapshots, exact supervisor-review ownership, and mandatory bounded review for unsupervised targets match this specification.
   - Verify: mocked concurrent reviewer/model tests for unsupervised partitions, coverage and `unknown` proof tests, failure/manager-judgment tests, and any/all integration waits.
   - Files: wait tool, review supervisor, settings.

5. **Launch and topology gate**
   - Acceptance: launch and pane/tab mutations use runtime-owned workload topology, minted names, resource bookkeeping, autonomous exact close, protected ancestors, and authoritative post-state reads; a launch appends its Task decision to the decision log before dispatching children under the contract above.
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
- Communication distinguishes normal prompt, explicit steer, named keys, cancel, and interrupt; a normal prompt submits through the same direct path an explicit steer uses on every sendable state; steer never synthesizes an interrupt; turn control binds one key to one stable working identity and independently verifies the outcome.
- Wait supports the specified raw/semantic states, literal/regex output, any/all, explicit one-hour maximum, structured timeout snapshots, and long-wait reviewer ownership partitioning.
- Reviewer calls are in-process, tool-less, concurrent per unsupervised target, bounded, non-mutating, fixed at low thinking, use the extension-owned reviewer model (default `openai-codex/gpt-6-sol`), and fail immediately without fallback when unavailable. Active exact supervisors own review for their covered children, and reviewer `unknown` requires a fresh exact working-state proof to be suppressed.
- Every launch is one caller-authored Task; the runtime mints child names and derives the workload profile, and Jev evaluation plus deterministic admission ensure every executed child runs a contract compiled for a reviewed operating point. Pi and Claude bind exact supervision before prompt delivery. AGY requires a self-contained initial prompt, publishes provisional supervision before its single submission, and strengthens to exact native-session supervision before success, recipient registration, or attachment access. Failed launches are never automatically cleaned.
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
4. Herdr exposes no dedicated semantic steer command. `agent prompt` writes text plus Enter directly to the agent PTY; a working agent's own TUI determines how that input is handled. The extension must never synthesize steering by sending Escape first. Launch initial-prompt submission is single-shot; confirmation never sends a recovery Enter or retries the prompt.
5. New tabs may cause Herdr to return an initial child pane. That pane must be labeled from the caller's requested/default launch label before it is used.
6. Ownership bookkeeping intentionally does not survive extension reload or Pi session changes, even when the Herdr resources remain alive; close authorization is based on the explicit exact target and fresh protected topology, not ownership.
7. The extension directory is a standalone Git repository with no remote initially. The implementation phase must run `git init`, verify the empty remote list, and create the initial commit containing the reviewed `SPEC.md` before implementation proceeds.

There are no approved open product questions for the core scope. Any implementation ambiguity not resolved by this document must fail closed and be raised for review rather than expanded into a new capability.

## Boundaries and implementation style

- **Always:** use strict TypeScript types and Pi custom-tool schemas; use `StringEnum` for string enums where required by Pi provider compatibility; pass `AbortSignal`; use explicit CLI argv; validate before mutation; re-read authoritative post-state; keep output bounded; run tests before release validation.
- **Ask first:** adding dependencies, changing the extension-owned settings path or JSON schema, changing the seven public schemas, changing ownership lifetime, adding a new Herdr command group, or touching an existing managed extension.
- **Never:** edit `herdr-agent-state.ts`; add compatibility aliases; add deferred tools; infer IDs; target UI focus implicitly; execute arbitrary commands/executables; send raw key sequences; read settings from Pi's global namespace or project-local files; accept tool-call settings overrides; auto-clean failed launches; auto-close unowned/mixed resources without UI; use fallback models or generic success fallbacks; mutate the active Courier workspace in integration tests.

The implementation should keep CLI access, target resolution, ownership, wait supervision, tool registration, and TUI rendering modular. It should follow Pi's custom-tool result shape and renderer lifecycle from the reviewed extension API documentation without introducing an abstraction that is not required by these contracts.
