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

All Herdr operations go through `pi.exec("herdr", argv, options)` with an argument array. The extension must not invoke a shell string, call Herdr's socket directly, reimplement the Herdr protocol, or synthesize Herdr identifiers.

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

The caller's context is taken from Herdr-injected IDs (`HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID`) and authoritative CLI reads. If those values are missing or inconsistent, health reports the condition and operations requiring that context fail closed.

## Common schemas and result rules

The following are reviewable contracts, not implementation code.

### Common scalar types

- `TargetRef`: non-empty string; exact stable ID, `current`, exact pane label, or unique agent name as permitted by the operation.
- `Direction`: one of `right`, `down`, `left`, `up`.
- `AgentState`: raw Herdr state `idle`, `working`, `blocked`, `done`, or `unknown`.
- `SemanticState`: `started`, `completed`, or `needs_input`.
- `NamedKey`: one token from the installed Herdr CLI's supported named-key vocabulary. Raw bytes, escape sequences, control-character strings, and arbitrary text are invalid. Unknown key names fail before CLI mutation.
- `EnvMap`: a string-to-string map. Environment variable names are not restricted by an extension allowlist; only values that cannot be represented by the CLI transport are rejected.

Schemas are strict: unknown top-level fields and invalid discriminant combinations are rejected. Strings containing NUL or newline where the target/label/name is a single identifier are invalid.

### Result envelope

Every successful tool result contains:

- concise human-readable `content` text;
- structured `details` containing the operation, resolved target/resource IDs, authoritative result, and warnings if applicable;
- no unbounded CLI transcript or raw stderr.

Mutation results include authoritative post-state. For a closed resource, the post-state is the authoritative containing context and a list of removed IDs, because the closed resource can no longer be read. Tool renderers show a compact row by default and may show structured details when expanded.

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

- `context` is the default, resolves the caller's current pane/context, and uses the same single-target payload: authoritative metadata plus at most the 100 most recent unwrapped output lines, in order.
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

**Execution:** This mutating tool is registered with `executionMode: "sequential"` so prompt/key/steer calls cannot overlap.

**Purpose:** Send a normal prompt, explicitly steer an agent, or send named keys. This tool does not wait for completion.

**Input:** exactly one of these operation shapes:

```text
{ target: TargetRef, operation: "prompt", text: string }
{ target: TargetRef, operation: "steer",  text: string }
{ target: TargetRef, operation: "keys",   keys: NamedKey[] }
```

Rules:

- Every operation reads and classifies the authoritative pre-state before sending bytes. `unknown` or malformed state returns a typed no-send error.
- `prompt` and `steer` resolve the authoritative sender from the same fresh snapshot used for target resolution, reject self-targeting, and send the mandatory v1 inter-agent envelope. There is no raw-text or provenance opt-out.
- `prompt` refuses to interrupt `working` targets and fails with `TARGET_BUSY`; idle, done, and blocked targets receive the bounded prompt command directly.
- `steer` never sends Escape or any other interrupt key. For idle, working, done, or blocked targets it submits the text directly through Herdr's `agent prompt` path; when the agent is working, its own TUI receives that submitted prompt as steering input. A working steer omits Herdr's `--wait` flags because Herdr 0.8 can time out that wait after successfully dispatching to an already-working agent; the prompt envelope and immediate authoritative post-read provide bounded submission evidence. Unknown or malformed state is a typed no-send failure.
- `keys` sends only validated named keys. There is no additional confirmation prompt for keys.
- Idle/done/blocked `prompt` and `steer` briefly wait for the target to enter `working`. A steer whose authoritative pre-state is already `working` submits without wait flags and verifies the immediate post-state. No communication operation waits for completion.
- Every Herdr envelope ID is retained for prompt/key/post-state calls. Details include bounded pre/post state and route (`prompt_direct` or `steer_direct`).
- After every operation, the tool returns the authoritative target post-state. A verification timeout or contradictory post-state is a structured failure, not a fabricated success.

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
  timeoutMs: integer // required, 1 through 3,600,000 inclusive
}
```

Rules:

- `targets` has at least one item. Duplicate target references that resolve to the same resource are rejected.
- `match: any` completes when one target satisfies the condition; `match: all` completes when every target satisfies it.
- Raw states are `idle`, `working`, `blocked`, `done`, and `unknown`.
- Semantic `started` matches `working`; `completed` matches `idle` or `done`; `needs_input` matches `blocked`.
- Output conditions search the target's recent unwrapped output through the installed CLI. Literal and regex are mutually exclusive. Invalid regex syntax is a structured input failure. Existing output is eligible, so a condition already satisfied completes immediately.
- A timeout is not an exception. It returns structured `matched: false`, `reason: "timeout"`, and final authoritative snapshots for every target. It never returns an unbounded wait or silently changes the requested timeout.
- A caller abort is distinct from a timeout and ends the operation with `ABORTED`.

#### Long-wait review supervision

A wait whose timeout is longer than the configured review cadence is a long wait. This threshold is an explicit implementation assumption because the product decision specifies cadence but not a separate threshold.

Long waits use mandatory in-process, tool-less reviewer calls:

- The reviewer model is the extension-owned setting from `config.json`, default `openai-codex/gpt-5.6-luna`; the tool cannot select or override it.
- Reviewer thinking is fixed at `low`; the tool cannot select or override it.
- At every review interval, one independent reviewer call is made per target, all concurrently, with no target-count cap.
- Reviewer calls are not Herdr panes, are invisible in Herdr topology, receive no tools, and cannot mutate or communicate.
- Each reviewer receives only bounded transcript deltas since the previous review plus compact authoritative metadata. The bounded transcript input is at most the same 100 recent unwrapped lines used by single-target inspection; unchanged lines must not be resent when a smaller delta is available.
- A reviewer may summarize/classify only `progress`, `stalled`, `blocked`, `risk`, `completed`, or `unknown` and may provide a bounded summary.
- A reviewer result that says manager judgment is required ends the wait early with `matched: false`, `reason: "manager_judgment_required"`, final snapshots, and reviewer summaries.
- Reviewer/model failure ends the wait immediately with `REVIEWER_FAILED`; there is no fallback model, pane, or silent continuation.
- Reviewer summaries appear in streamed progress and final tool details. The reviewer never changes the authoritative wait condition: only Herdr state/output can satisfy it.

### Detached wait jobs and `herdr_jobs`

`herdr_wait` accepts an optional camelCase `runInBackground` boolean. Its schema is strict: omitted or `false` retains the blocking behavior, while snake_case and unknown fields are rejected. Background mode performs parameter validation, extension-owned settings loading, one authoritative snapshot read, exact target resolution, and duplicate resolved-resource rejection before registering anything. These preflight steps use the initiating tool signal and throw directly on failure without creating a job.

After preflight, the extension registers a stable opaque `job_${randomUUID()}` identifier and runs the same prepared wait engine used by foreground waits under a fresh per-job `AbortController`. The prepared params, settings, and resolved IDs are copied at registration. Timeout starts after preflight. The initiating signal and call-scoped update callback are never used by post-registration work. A session generation/token check prevents stale preflight from registering into a replacement session.

The in-memory, session-wide registry has no concurrency cap and retains terminal jobs until shutdown. Generic job status is `running`, `completed`, `failed`, or `cancelled`; wait outcome is separately `success`, `timeout`, or `manager_judgment_required`. Only latest bounded progress is stored. Terminal transitions are first-wins. `herdr_jobs` is the sole public registry view and is strict:

- `{operation:"list", status?, offset?, limit?}` filters by generic status, orders newest-first by insertion sequence, filters before pagination, defaults offset to `0` and limit to `20`, caps limit at `100`, and returns `{total,nextOffset,jobs}` with transcript-free summaries.
- `{operation:"get", jobId}` returns a bounded, typed full current/terminal detail for an owned job.
- `{operation:"cancel", jobId}` marks a running job cancelled before aborting it, returns immediately without awaiting cleanup, and is idempotent. Unknown IDs are structured `JOB_NOT_FOUND`; terminal jobs are returned unchanged.

On session shutdown, notification delivery is disabled first, running jobs are marked/aborted, cleanup is allowed to settle safely, and registry ownership/generation is reset. `/tree` does not cancel jobs. Completion notifications target the current active branch and are best-effort. Background success, timeout, failure, and manager judgment send one compact visible custom Pi message with `deliverAs: "steer"` and `triggerTurn: true`; explicit cancel and shutdown cancellation never notify. Manager judgment messages start with `HIGH PRIORITY: MANAGER JUDGMENT REQUIRED` and use details priority `high`; other outcomes use normal priority. Messages include the job ID, outcome/reason, matched targets, and bounded error/reviewer summary, treating pane/output text as untrusted data. Pi's normal queue is used without custom debounce.

All model-visible content, list summaries, completion notifications, and renderers enforce Pi's 50KB/2,000-line bounds with explicit truncation and no full transcripts. No background resource starts in the extension factory; only tool execution registers jobs.

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
- Profile body sources are created before topology mutation. Initial prompts are sent only after the selected agent starts, wrapped in the mandatory v1 assignment envelope, and verified as `working`.
- Overrides apply only to the requested primary profile. Every fallback uses its own untouched defaults, including runtime, model, source, timeout, and permissions.
- Automatic fallback is permitted only for the exact machine-typed Herdr error `agent_start_failed` with message `process exited before becoming interactive`, followed by an authoritative pane read proving that no agent remains. Timeout, malformed/protocol, identity/kind, prompt, and uncertain-state failures stop without fallback.
- Fallback attempts reuse the resolved pane; the ordered reachable profile chain is deterministic and capped at three. An exhausted chain stops and reports bounded attempt evidence; no profile is improvised.
- Launch details report requested and selected profiles, effective runtime/model/source/timeout/permissions, bounded attempt evidence, authoritative IDs/post-state, and any visible provenance. Failed launches retain created resources and never auto-clean them.

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
- `LAUNCH_FAILED`: agent start failed; any created resources remain.
- `READY_TIMEOUT`: launch readiness verification timed out.
- `OWNERSHIP_LOST`: a required owned-resource fact is no longer valid in this runtime.
- `PROTECTED_RESOURCE`: operation would close the caller pane or its containing tab/workspace.
- `MUTATION_UNCERTAIN`: a dispatched destructive mutation has no trustworthy response and post-state cannot prove target absence.
- `ABORTED`: caller `AbortSignal` was aborted.
- `WAIT_REVIEW_REQUIRED`: a long wait cannot be supervised under the configured rules.
- `REVIEWER_FAILED`: any required in-process reviewer/model call failed.
- `MANAGER_JUDGMENT_REQUIRED`: reviewer ended the wait early because the result requires manager judgment.
- `CLI_TIMEOUT`: an individual CLI call exceeded its bounded internal timeout.

`herdr_wait` timeout is a normal structured result with `matched: false`, not `CLI_TIMEOUT`. No error path may substitute a guessed ID, focused pane, fallback model, generic success, or automatic cleanup.

## Security and safety boundaries

- The extension is global code with full Pi permissions; it is trusted code and must remain narrowly scoped.
- Registration is gated by `HERDR_ENV=1`.
- All process execution uses `pi.exec` with explicit executable and argument arrays. No shell interpolation, command concatenation, arbitrary executable input, or direct socket protocol implementation is allowed.
- `herdr_launch` accepts a Herdr-supported `kind` and arguments only, never an executable string.
- Target resolution is exact and fail-closed. The extension never relies on UI focus or guesses an ID.
- Named keys are validated symbols, never raw escape/control strings. Key delivery does not add a second confirmation dialog.
- Destructive close operations are autonomous only after exact target and protected-topology validation. No UI is required, but malformed topology fails closed.
- Environment overrides accept arbitrary variable names by product decision. They can expose secrets or control process behavior to the launched child and may be visible through Herdr process/session inspection; normal tool output must not echo their values. Callers remain responsible for not supplying sensitive values in a shared session.
- Long-wait reviewers receive only bounded metadata/transcript deltas, have no tools, cannot mutate or communicate, and are not visible as Herdr panes. Reviewer failures fail closed.
- Every CLI and model call observes `AbortSignal`; close post-readback uses a fresh independent signal so completed destructive mutations cannot lose terminal evidence.
- The extension does not read, write, replace, or report state through `herdr-agent-state.ts`; Herdr's managed state integration remains the authority for the calling Pi pane's lifecycle state.
- Integration tests use a disposable named Herdr session and never mutate the active Courier workspace.

## TUI and output behavior

Each tool has a compact custom call/result row using Pi's extension renderer APIs:

- Call rows show the tool name, operation, and resolved human-readable target label/name when known.
- Result rows show a short status such as inspected, sent, waiting, launched, updated, or closed, plus IDs/statuses needed for the next action.
- `working`, `blocked`, `idle`/`done`, timeout, reviewer failure, protected, reconciled, and uncertain states use distinct semantic styling.
- `herdr_wait` and `herdr_launch` stream bounded progress through `onUpdate`. Wait progress includes target state changes and reviewer summaries; launch progress includes placement, readiness, and prompt verification.
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
│   ├── tools/                      # seven tool implementations
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
npm run test:integration -- --session herdr-tools-integration
npm run typecheck
npm run lint
npm run build
```

The integration command must create/use only the disposable named session `herdr-tools-integration`, use explicit returned IDs, avoid the active Courier workspace, and tear down only its own fixture after assertions. It must not run against the default active Herdr session.

Before integration execution, the harness must verify the session name is disposable and not attached to the active Courier context. A failed `herdr_launch` assertion must leave its created resources visible for the test's diagnostic result; fixture teardown may clean only resources/session explicitly created by the test harness after recording the failure.

## Testing strategy

Testing is test-first. Tests are written before the corresponding implementation phase and must cover all changed files at 100% changed-file coverage, including branches for fail-closed behavior.

### Mocked unit tests

Mock `pi.exec`, CLI stdout/stderr/exit codes, target listings, post-state reads, resource records, `AbortSignal`, `onUpdate`, and in-process model calls. Cover:

- disabled registration and exact seven-tool registration;
- strict schemas and cross-field validation;
- exact ID/current/label/name resolution, missing and ambiguous matches;
- current-context protection from UI focus;
- single-target 100-line inspect cap and collection compactness;
- health environment and client/server compatibility reporting;
- normal prompt refusal while working;
- explicit steer submission to idle/done/blocked/working targets with zero interrupt-key calls;
- named-key validation without confirmation;
- wait state semantics, literal/regex matching, any/all, immediate matches, bounded timeout final snapshots, abort, and internal CLI failures;
- every long-wait reviewer rule, including concurrent one-per-target calls, bounded deltas, no tools, manager-judgment early exit, and immediate reviewer failure;
- unique launch names, supported kinds, placement defaults, argv separation, initial prompt readiness, post-state reads, and failed-launch retention;
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
- Communication distinguishes normal prompt, explicit steer, and named keys; normal prompt never interrupts a working target; no communication operation waits for completion.
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
