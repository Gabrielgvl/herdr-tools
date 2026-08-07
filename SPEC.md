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
- When enabled, the factory registers only the six core tools. Registration uses Pi's custom-tool API and strict schemas. There are no compatibility aliases or deprecated input fields.
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

### `herdr_communicate`

**Purpose:** Send a normal prompt, explicitly steer an agent, or send named keys. This tool does not wait for completion.

**Input:** exactly one of these operation shapes:

```text
{ target: TargetRef, operation: "prompt", text: string }
{ target: TargetRef, operation: "steer",  text: string }
{ target: TargetRef, operation: "keys",   keys: NamedKey[] }
```

Rules:

- `prompt` resolves the target and reads its authoritative state first. If it is `working`, the operation fails with `TARGET_BUSY`; it must not silently interrupt the agent.
- `steer` is explicit. It sends the installed CLI's named interrupt operation first, then sends the prompt. The current CLI mapping is the named `Escape` key through the agent/pane key path; the adapter must use the CLI authority rather than raw terminal escape bytes. If the interrupt fails, the prompt is not sent.
- `keys` sends only validated named keys. There is no additional confirmation prompt for keys.
- For `prompt` and `steer`, the tool briefly verifies that the target enters `working` and returns immediately after that verification. It never waits for completion.
- After every operation, the tool returns the authoritative target post-state. A verification timeout or contradictory post-state is a structured failure, not a fabricated success.

### `herdr_wait`

**Purpose:** Wait for one or many exact agent/pane targets to satisfy a state or output condition.

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

**Purpose:** Launch a caller-named Herdr-supported agent in a pane, optionally deliver its first prompt, and return authoritative launch state.

**Input:**

```text
{
  name: string,                              // required, caller-chosen and unique
  kind: SupportedHerdrAgentKind,             // required
  argv?: string[],                           // optional agent arguments only
  placement?:
    { mode: "same_tab" }                    // default
    | { mode: "new_tab", tabLabel: string }
    | { mode: "existing_pane", target: TargetRef },
  label?: string,                            // pane label; default: name
  cwd?: string,                              // default: current Pi cwd
  env?: EnvMap,                              // optional child environment overrides
  focus?: boolean,                           // default: false
  initialPrompt?: string                     // optional prompt after readiness
}
```

`SupportedHerdrAgentKind` is the set reported by the installed CLI. At the current CLI version it includes `pi`, `claude`, `codex`, `gemini`, `cursor`, `devin`, `agy`, `cline`, `omp`, `mastracode`, `opencode`, `copilot`, `kimi`, `kiro`, `droid`, `amp`, `grok`, `hermes`, `kilo`, `qodercli`, and `maki`. The CLI remains authoritative; unsupported kinds fail closed.

Rules:

- `name` is required and must be unique according to an authoritative agent listing. The extension never generates a name or silently renames a collision.
- `argv` contains arguments for the selected agent kind only. There is no executable/path field and arbitrary executable strings are rejected. Arguments are passed after the CLI's argument delimiter.
- Default placement splits the current pane to the right in the current tab, with no focus change, current Pi cwd, and a pane label equal to `name` unless `label` is supplied.
- `new_tab` explicitly creates a labeled tab in the current workspace, with no focus by default. Any pane returned/created for the new tab is labeled before the agent is started.
- `existing_pane` explicitly starts in the resolved existing pane and does not create a replacement pane.
- `focus: true` is the only way this tool changes focus.
- If `initialPrompt` is provided, the tool waits only for the new agent to be ready, sends the prompt, and briefly verifies `working`; it does not wait for completion.
- Progress is streamed for placement, agent start, readiness, and prompt verification.
- A failed launch is never automatically cleaned up. Any pane or tab already created remains visible and is returned in failure details for manual handling.
- Launch returns the authoritative agent name, agent ID if supplied by Herdr, pane ID, tab ID, placement, and post-state. IDs are always read from Herdr responses.

### `herdr_pane`

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
- Close applies the ownership and protected-resource rules below. It never performs automatic cleanup or cascaded cleanup.
- Every successful mutation re-reads affected pane/layout/tab context and returns authoritative post-state. Close returns the containing context and removed IDs.

### `herdr_tab`

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
- Close applies the ownership and protected-resource rules. The tool cannot close the tab containing the calling pane or cause the calling workspace to close.
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
- A resource may be closed without an interactive confirmation only when the close was explicitly requested and the resource plus every descendant that would be affected is owned by this current runtime.
- Unowned or mixed-owned resources require an interactive confirmation through `ctx.ui`. If `ctx.hasUI` is false, confirmation is unavailable and the operation fails closed with `CONFIRMATION_UNAVAILABLE`; it must not assume consent.
- The pane containing the calling Pi agent, its containing tab, and its containing workspace are protected and can never be closed by these topology tools. Preflight must also reject an operation that would implicitly close one of those ancestors.
- Failed launches do not trigger ownership-based cleanup. Created resources remain available for inspection and manual closure.

Ownership checks are performed against fresh authoritative topology before close. A stale ownership map never grants permission to close an unowned resource.

## Error taxonomy

Errors are stable, concise, and machine-readable in structured details. At minimum, the implementation defines these codes:

- `HERDR_ENV_REQUIRED`: extension operation attempted without the required Herdr environment. Normally unreachable because tools are not registered when disabled.
- `CONTEXT_UNAVAILABLE`: required injected ID or current context is absent.
- `CLI_NOT_FOUND`: installed `herdr` executable is unavailable.
- `BACKEND_UNAVAILABLE`: CLI cannot reach the Herdr server/socket.
- `CLI_PROTOCOL_ERROR`: malformed or contradictory CLI output.
- `CLIENT_SERVER_INCOMPATIBLE`: health detects incompatible client/server versions or schemas.
- `INVALID_INPUT`: schema or cross-field validation failure.
- `INVALID_SETTINGS`: invalid extension-owned setting.
- `TARGET_NOT_FOUND`: no exact target match.
- `TARGET_AMBIGUOUS`: multiple exact target matches.
- `TARGET_TYPE_MISMATCH`: exact target exists but cannot serve the requested operation.
- `TARGET_BUSY`: normal prompt attempted against a working target.
- `KEY_REJECTED`: key is not a supported named key.
- `POSTSTATE_UNAVAILABLE`: mutation completed or may have completed, but authoritative post-state could not be read.
- `LAUNCH_FAILED`: agent start failed; any created resources remain.
- `READY_TIMEOUT`: launch readiness verification timed out.
- `OWNERSHIP_LOST`: a required owned-resource fact is no longer valid in this runtime.
- `PROTECTED_RESOURCE`: operation would close the caller pane or its containing tab/workspace.
- `CONFIRMATION_UNAVAILABLE`: destructive operation needs UI confirmation but no UI is available.
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
- Destructive close operations are ownership-aware and UI-confirmed for unowned/mixed resources. No UI means no confirmation and no close.
- Environment overrides accept arbitrary variable names by product decision. They can expose secrets or control process behavior to the launched child and may be visible through Herdr process/session inspection; normal tool output must not echo their values. Callers remain responsible for not supplying sensitive values in a shared session.
- Long-wait reviewers receive only bounded metadata/transcript deltas, have no tools, cannot mutate or communicate, and are not visible as Herdr panes. Reviewer failures fail closed.
- Every CLI and model call observes `AbortSignal`.
- The extension does not read, write, replace, or report state through `herdr-agent-state.ts`; Herdr's managed state integration remains the authority for the calling Pi pane's lifecycle state.
- Integration tests use a disposable named Herdr session and never mutate the active Courier workspace.

## TUI and output behavior

Each tool has a compact custom call/result row using Pi's extension renderer APIs:

- Call rows show the tool name, operation, and resolved human-readable target label/name when known.
- Result rows show a short status such as inspected, sent, waiting, launched, updated, or closed, plus IDs/statuses needed for the next action.
- `working`, `blocked`, `idle`/`done`, timeout, reviewer failure, and protected/confirmation states use distinct semantic styling.
- `herdr_wait` and `herdr_launch` stream bounded progress through `onUpdate`. Wait progress includes target state changes and reviewer summaries; launch progress includes placement, readiness, and prompt verification.
- Default output never prints full transcripts, environment values, raw CLI JSON, or reviewer prompts. Expanded details may show the fixed bounded transcript and structured metadata.
- Errors render their stable code and concise reason. They do not look like successful operations.
- TUI-specific rendering is guarded by Pi mode capabilities; RPC receives structured results, and non-UI modes never attempt interactive confirmation.

## Project structure

The implementation belongs only under the separate directory below:

```text
/home/gabriel/.pi/agent/extensions/herdr-tools/
├── SPEC.md                         # this specification
├── index.ts                        # global extension factory and six registrations
├── package.json                    # only if dependencies/scripts are needed
├── config.json                     # optional extension-owned configuration
├── src/
│   ├── cli.ts                      # pi.exec-based Herdr adapter
│   ├── targets.ts                  # exact target resolution
│   ├── schemas.ts                  # strict public tool schemas/types
│   ├── ownership.ts                # current-runtime ownership and close guards
│   ├── settings.ts                 # extension-owned settings validation
│   ├── wait-review.ts              # bounded, tool-less in-process reviewers
│   ├── tools/                      # six tool implementations
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

Mock `pi.exec`, CLI stdout/stderr/exit codes, target listings, post-state reads, ownership records, Pi UI confirmation, `AbortSignal`, `onUpdate`, and in-process model calls. Cover:

- disabled registration and exact six-tool registration;
- strict schemas and cross-field validation;
- exact ID/current/label/name resolution, missing and ambiguous matches;
- current-context protection from UI focus;
- single-target 100-line inspect cap and collection compactness;
- health environment and client/server compatibility reporting;
- normal prompt refusal while working;
- explicit steer interrupt-before-prompt ordering;
- named-key validation without confirmation;
- wait state semantics, literal/regex matching, any/all, immediate matches, bounded timeout final snapshots, abort, and internal CLI failures;
- every long-wait reviewer rule, including concurrent one-per-target calls, bounded deltas, no tools, manager-judgment early exit, and immediate reviewer failure;
- unique launch names, supported kinds, placement defaults, argv separation, initial prompt readiness, post-state reads, and failed-launch retention;
- all pane/tab topology operations and default direction/focus behavior;
- environment overrides without an extension key allowlist and without value echoing;
- ownership loss, owned-only close, mixed/unowned confirmation, no-UI fail-closed behavior, and caller ancestor protection;
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
   - Acceptance: separate global entry point exists; disabled mode registers nothing; enabled mode registers exactly six tools; existing sibling files are untouched.
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
   - Acceptance: launch and pane/tab mutations use explicit placement, labels, ownership, confirmations, protected ancestors, and authoritative post-state reads.
   - Verify: mocked mutation/ownership tests followed by disposable-session integration tests.
   - Files: launch, pane, tab, ownership, CLI adapter.

6. **TUI and release validation gate**
   - Acceptance: compact custom rows and streamed progress are available without leaking raw output or environment values; all required commands are clean.
   - Verify: renderer tests, full coverage, typecheck, lint, build, and disposable integration run.
   - Files: renderers and only the files changed by the prior phases.

## Success criteria

The feature is complete only when all of the following are true:

- A Pi process outside Herdr exposes none of the six tools.
- A Pi process inside Herdr exposes exactly the six named core tools and no deferred tool.
- Every target operation uses an exact stable ID/current context, exact pane label, or unique agent name and fails closed otherwise.
- Inspection has the specified current, single-target, collection, and health behavior.
- Communication distinguishes normal prompt, explicit steer, and named keys; normal prompt never interrupts a working target; no communication operation waits for completion.
- Wait supports the specified raw/semantic states, literal/regex output, any/all, explicit one-hour maximum, structured timeout snapshots, and mandatory reviewer supervision for long waits.
- Reviewer calls are in-process, tool-less, concurrent per target, bounded, non-mutating, fixed at low thinking, use the extension-owned reviewer model (default `openai-codex/gpt-5.6-luna`), and fail immediately without fallback when unavailable.
- Launch requires a unique caller name and supported kind, uses the specified placement defaults, supports argv without arbitrary executables, verifies initial work, streams progress, and never cleans failed launches.
- Pane and tab topology operations implement the specified defaults, labels, environment behavior, ownership confirmations, protected ancestors, and authoritative post-state.
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
4. `Escape` is the installed CLI's named interrupt mapping for explicit steer. The implementation must validate/use the CLI-supported named-key path, not send raw terminal bytes.
5. New tabs may cause Herdr to return an initial child pane. That pane must be labeled from the caller's requested/default launch label before it is used.
6. Ownership intentionally does not survive extension reload or Pi session changes, even when the Herdr resources remain alive.
7. The extension directory is a standalone Git repository with no remote initially. The implementation phase must run `git init`, verify the empty remote list, and create the initial commit containing the reviewed `SPEC.md` before implementation proceeds.

There are no approved open product questions for the core scope. Any implementation ambiguity not resolved by this document must fail closed and be raised for review rather than expanded into a new capability.

## Boundaries and implementation style

- **Always:** use strict TypeScript types and Pi custom-tool schemas; use `StringEnum` for string enums where required by Pi provider compatibility; pass `AbortSignal`; use explicit CLI argv; validate before mutation; re-read authoritative post-state; keep output bounded; run tests before release validation.
- **Ask first:** adding dependencies, changing the extension-owned settings path or JSON schema, changing the six public schemas, changing ownership lifetime, adding a new Herdr command group, or touching an existing managed extension.
- **Never:** edit `herdr-agent-state.ts`; add compatibility aliases; add deferred tools; infer IDs; target UI focus implicitly; execute arbitrary commands/executables; send raw key sequences; read settings from Pi's global namespace or project-local files; accept tool-call settings overrides; auto-clean failed launches; auto-close unowned/mixed resources without UI; use fallback models or generic success fallbacks; mutate the active Courier workspace in integration tests.

The implementation should keep CLI access, target resolution, ownership, wait supervision, tool registration, and TUI rendering modular. It should follow Pi's custom-tool result shape and renderer lifecycle from the reviewed extension API documentation without introducing an abstraction that is not required by these contracts.
