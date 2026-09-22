# Herdr Tools

Safe inspection and coordination of Herdr panes, agents, tabs, and topology. It is inert outside a Herdr pane (`HERDR_ENV=1`) and exposes exactly seven tools: `herdr_inspect`, `herdr_communicate`, `herdr_wait`, `herdr_jobs`, `herdr_launch`, `herdr_pane`, and `herdr_tab`.

Two hosts serve the same implementation. Pi loads the extension through the root `index.ts`; an interactive Claude Fable manager session reaches the same seven tools through a local stdio MCP server. Schemas, target resolution, bounds, ownership, launch policy, and provenance exist once, in `src/tool-surface.ts` and the modules below it.

`herdr_wait` is the MCP state/output wait tool. It is not a CLI lifecycle command: CLI readiness uses `herdr agent wait`, while output conditions are evaluated from authoritative pane output.

Every successful `herdr_launch` also creates a **supervisor**: a whole-life, session-scoped watcher of that exact child, listed and inspected through the existing `herdr_jobs` tool as a first-class `kind: "supervisor"` job. Supervision observes and reports; it never mutates the child and never adds a tool.

## Quick start

```bash
cd /home/gabriel/.pi/agent/extensions/herdr-tools
npm install
cp config.json.example config.json # optional; edit only extension-owned wait settings
```

Pi discovers the directory through its root `index.ts` when it is installed at `/home/gabriel/.pi/agent/extensions/herdr-tools/`. The installed `herdr` CLI is the only Herdr authority. Neither host intercepts raw Herdr Bash and neither launches an arbitrary executable.

## Harness flow

Complex engineering work uses the bundled `harness-flow` skill: `explore → plan → work → critic → promote`. Every phase runs in a separate spec-launched agent, `pi-review` supplies auxiliary critic evidence, and the promote phase finalizes the exact reviewed tree. The direct path remains the default when one bounded worker plus one objective gate can finish safely. Outside `HERDR_ENV=1`, the flow fails closed rather than substituting hidden agents or raw CLI control.

The canonical skill is `herdr-profiles/role-plugins/manager/skills/harness-flow/SKILL.md`. Install or link that directory into the global skill stores for Pi, Claude, Codex, and Hermes so ad-hoc sessions apply the same activation gate.

## Task launches, tiers, and operating points

`herdr_launch` is Task-only: the caller authors exactly one flat Task per call — `objective`, `scope`, `doneWhen`, optional `constraints`, optional `tier` (the requested starting quality/compute posture: `utility` < `economy` < `standard` < `strong` < `frontier` < `max`; omission means `standard`), optional `replicas`, optional `recoveryOf`, `label` (display metadata), and `cwd`. Specs, categories, assignments, caller naming, placement, focus, delivery overrides, and request-level supervision digests are deleted — the strict schema rejects every undeclared field with no compatibility alias.

```text
herdr_launch({"objective":"Inspect the current changes","scope":"Read-only review of the working tree","doneWhen":["Findings reported with file:line references"],"constraints":["read-only"],"label":"inspect","tier":"standard"})
```

Each Task is evaluated by Jev (`jev-latest`) in one `systemOne` call — a `done_when_verifiable` quality gate, six closed workload-dimension choices (intent, mutation, scope, horizon, verifiability, ambiguity; workspace state is runtime-derived), per-resource judgments, and per-point fitness — then admitted by deterministic policy: the requested tier's floor/ceiling envelope filters the reviewed operating-point catalog (`herdr-profiles/catalog.yaml` v2 — each runner's models crossed with supported reasoning settings into exact `{runner, model, reasoning}` points carrying cost/latency classes), availability pre-filters, and the highest-fitness point is selected. The fallback chain contains same-tier points only, bounded at four attempts, ordered by fitness then provider diversity, with availability re-probed immediately before each start. A selected point compiles through `compileCandidateContract` into runner-specific argv — Pi gets `--tools`/`--extension`/`--skill` selections from the reviewed pools, Claude gets allowed/disallowed tools and plugin dirs, and AGY and Devin consume no pool fields. Admission failures are typed abstentions with zero launch effects; the single per-Task decision is appended once to `.herdr/router/decisions.jsonl` under the session project root before the first child mutation.

Children are runtime-minted `task-<launchId-8>-<ordinal>` names and land on runtime-owned `workload:<intent>` tabs (`workload:<intent>:<n>` spillovers) as unfocused right-split panes; `replicas > 1` gives each replica an isolated worktree under `.herdr/worktrees/`. The uniform `launch` result carries `outcome` of `launched`/`abstained`/`partial`/`failed` plus one entry per child (`target`, `state`, `operatingPointId`, `supervisorJobId`, `worktree`, bounded `error`); `partial` retains mixed outcomes as they stand: nothing is closed, rolled back, or resubmitted — inspect surviving children through their supervisor jobs and delegate the remainder explicitly. The public `herdr_jobs` projection exposes `operatingPointId` (the point that actually started the child) and, when fallback changed the selection, `requestedOperatingPointId`. `recoveryOf` relaunches a failed managed run under the same run lineage with a raised ceiling.

Task evaluation resolves its TypeSafe credential through `resolveTypesafeApiKey`: an explicit key, then the `TYPESAFE_API_KEY` environment variable, then the `typesafe` `api_key` entry in the Pi auth store (`~/.pi/agent/auth.json`) — the same bridge the supervision reviewer uses.

The catalog pools are reviewed selection sets, not an inventory of disk: installed Pi extensions, `~/.agents` skills, and host-provided plugins are ambient resources that launches can never be granted unless the owner promotes them into `catalog.yaml`. The reconciliation lives in `.herdr/artifacts/resource-mapping/skills-extensions.md`.

The normative contract is [the `herdr_launch` section of SPEC.md](SPEC.md#herdr_launch); the design rationale is [ADR-037](docs/decisions/037-quality-tier-workload-profile-routing.md).

## Claude Fable manager

A Claude Fable session running in a Herdr pane can act as the manager through the local stdio MCP server. Build the server, add the bundled marketplace, install the plugin globally for the user, then restart Claude:

```bash
cd /home/gabriel/.pi/agent/extensions/herdr-tools
npm run build:mcp
claude plugin marketplace add /home/gabriel/.pi/agent/extensions/herdr-tools --scope user
claude plugin install herdr-tools@herdr-tools --scope user -y
claude --model fable
```

`/mcp` must list the `herdr` server with the seven tools as `mcp__plugin_herdr-tools_herdr__herdr_inspect` through `mcp__plugin_herdr-tools_herdr__herdr_tab`. The bundled `manager` plugin under `herdr-profiles/role-plugins/manager/` provides this same MCP server plus the manager conduct skill for owner-requested Claude/Fable management or Claude-to-Claude succession. Inside a running session the owner switches models with `/model fable`; the packaged skill reports a mismatch and stops rather than claiming enforcement.

Startup is fail-closed. The server refuses to serve unless `HERDR_ENV=1`, the injected `HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`/`HERDR_PANE_ID` identity is present and valid, and the project directory resolves to an absolute existing directory below the filesystem root — an explicit `HERDR_PROJECT_DIR` override when set, otherwise the server's own launch directory, which every supported host already spawns as the session project directory. The selected value is shape-validated, resolved through the filesystem's realpath, and accepted only when its canonical target remains a valid existing non-root directory; any resolution failure refuses startup, and the canonical path anchors the session. A set-but-invalid `HERDR_PROJECT_DIR` refuses startup rather than re-anchoring; the plugin directory and module-relative paths are never used as a substitute.

### Caller context after pane moves

Injected Herdr IDs are bootstrap identity. Before each context-dependent tool call, the server reads `herdr pane current --current`, using the injected pane identity as the selection anchor, then verifies the returned effective pane against one authoritative `herdr api snapshot`. Herdr may return a new public pane ID for an old pane alias. When that happens, both records must carry the same terminal identity. The live tab and workspace IDs become the effective context. This lets the tools survive a same-workspace tab move or a cross-workspace move when Herdr still resolves the original pane alias.

`herdr_inspect` with `mode: "context"` reports `context.injected`, `context.effective`, and `context.rebound`. Other successful calls include bounded `contextRebinding` evidence only when a rebind occurred. Missing or malformed IDs, a missing or duplicate caller pane, incoherent parent relationships, pane replacement, protocol errors, and a topology that keeps changing fail closed. A small retry is used only for a concurrent live-read and snapshot race. Health continues to report syntactic environment presence and validity, so stale ancestor IDs are not falsely reported as malformed.

Model-visible content is bounded and redacted at the boundary: `details` and typed error evidence pass through one recursive projection that drops, at every depth, any environment-shaped key whose value could hold an environment value, oversized evidence becomes a parseable `{"truncated":true,"originalBytes":n,"preview":"…"}` envelope instead of a cut string, and a `herdr` call that floods a pipe past 1 MiB fails with `CLI_OUTPUT_OVERFLOW` rather than growing the server's memory. `herdr_communicate`, `herdr_pane`, and `herdr_tab` are serialized per session exactly as Pi schedules them, so two overlapping mutations cannot interleave; inspect, wait, and jobs stay concurrent.

Two host differences are deliberate:

- **Waits are detached and polled.** Every `herdr_wait` call performs its validation and target/context preflight, registers a session-scoped background job, and returns immediately with an opaque ID. Poll jobs with `herdr_jobs` `list` and `get`; cancel only through `herdr_jobs` `cancel`. Pi retains its existing terminal notification and active-wait UI, while the MCP host has no push notification.
- **Explicit wait review on MCP is unavailable.** An unsupervised job whose timeout exceeds `wait.reviewCadenceMinutes` fails closed with `REVIEWER_FAILED` in its `herdr_jobs` result. A long wait whose targets are all covered by active exact supervisors constructs no wait reviewer and can continue authoritative polling. Supervisor review uses the host-independent bundled model service. Use repeated bounded waits for unsupervised MCP targets, or raise the cadence (maximum 30) in `config.json`.

When `wait.reviewerModel` uses the opt-in `typesafe/<model>` form, the credential resolves through `resolveTypesafeApiKey`: `TYPESAFE_API_KEY` in the environment that launches the plugin first, then the `typesafe` `api_key` entry in the Pi auth store (`~/.pi/agent/auth.json`). A `.env` file alone is not read.

For refreshes, rebuild main, update the user-installed plugin, and restart Claude:

```bash
cd /home/gabriel/.pi/agent/extensions/herdr-tools
npm run build:mcp
claude plugin update herdr-tools@herdr-tools --scope user -y
```

The cached plugin intentionally points back to `/home/gabriel/.pi/agent/extensions/herdr-tools/dist/src/mcp-server.js`, so main installed at that path must be built. For development or sideloading, `claude --plugin-dir /home/gabriel/.pi/agent/extensions/herdr-tools/herdr-profiles/role-plugins/manager` remains an explicit alternative to the global marketplace installation.

## Automatic child supervision

A supervisor is reserved before the first topology mutation for every qualified launch. Every qualified recipient retains strict complete native-session readiness and exact binding before prompt dispatch. Every launch carries the canonical Task, so there is no promptless launch path. Binding drains queued evidence while the public job remains `reserved`, then commits `request.targetIds: [paneId]` and bound state together. A queued settlement or failed bind throws `SUPERVISION_UNCONFIRMED`, sends no prompt, registers no recipient, performs no retry or cleanup, and leaves the child and binding evidence available for inspection.

AGY's reduced-assurance provisional/strengthening contract (ADR-021/022) is live for runtime-selected AGY operating points: the fixed bootstrap establishes the native session, provisional supervision publishes before the single Task prompt submission, and exact native-session strengthening completes before launch success. Claude requests follow the same exact-identity, fresh-reread, one-send contract as Pi, and no blocked-recipient live receipt is inferred from a refusal.

Prompt confirmation is separate from supervision. If the single initial prompt might have taken effect but acknowledgement, semantic confirmation, or AGY strengthening fails, launch retains the child, supervisor, evidence, and recovery handles. It does not retry, fall back, clean up, release the reservation, register a recipient, or continue dependent work. Inspect the pane with `herdr_inspect` and the supervisor with `herdr_jobs get`. Fallback stays pre-execution only: a proven pre-spawn start failure, a quota-classified start failure, or a killed `CLI_TIMEOUT` start, each plus fresh authoritative proof that no agent occupies the pane.

Supervision watches the Herdr lifecycle stream directly and also reconciles authoritative state periodically. It holds **one** long-lived connection to `HERDR_SOCKET_PATH` for the whole session carrying a single acknowledged `events.subscribe`; Herdr 0.8.2 answers exactly one request per connection, so the subscription set is fixed and global, and every supervisor is multiplexed over it. Bind reads and periodic `session.snapshot` reads use separate short-lived unary connections. One shared snapshot runs every fixed 30 seconds while supervisors are live. Due times are monotonic, attempts do not overlap, and delayed ticks do not burst. The 5-second connect bound plus separate 10-second snapshot request bound gives a proven 45-second stale-status bound when the next attempt succeeds. Failed reads preserve the last projection and expose reconciliation degradation rather than starting CLI polling.

An exact supervisor is pinned by `terminal_id` plus the whole `agent_session` and anchored on the pane `revision`. AGY reaches this state only after strengthening. Pane IDs are reused, so thin events normally trigger reconciliation rather than conclusions. A non-clean `pane_exited` is the implemented exception: its exit fact is latched before reconciliation from the matching pane ID alone, so a delayed event from a prior occupant can be attributed to a replacement child. A full event revision jump or same-revision status contradiction emits a visible high-priority `evidence_gap`; a higher valid snapshot revision emits a source-`snapshot` gap even when its endpoint status is unchanged, then adopts that status and revision. Malformed, duplicate, contradictory, or lower-revision target-local snapshot evidence cannot settle a live supervisor. Proven pane moves rebase to the destination's pane-local revision. A degraded live supervisor remains visible and keeps semantic-review ownership.

Working starts are silent. The manager is woken for a completed work cycle, a block, reviewer attention, evidence or sink degradation and recovery, identity replacement or loss, release, pane close, reconciliation failure or recovery, and an evidence gap. A child that has been working continuously for the configured cadence is reviewed by Jev (`typesafe/jev-latest`, the `SUPERVISION_REVIEWER_MODEL` constant). One `systemOne` call per review judges six independent predicates plus a reason choice over bounded V2.1 evidence: the Task's `doneWhen` and `constraints`, a compact runner trace, Git workspace state, supplemental terminal lines, metadata, and previous-review state. The launch carrier does not supply `objective`, and the public schema has no `progressMarkers`, so those reviewer fields are absent and empty respectively. A valid worktree-column porcelain rename can make workspace evidence unavailable, which also skips the read-only dirty-workspace check for that cadence. The local safety scan is pattern-based; `safe` means no configured detector matched, not that arbitrary credentials are proven absent. A review whose work cycle ends mid-flight is abandoned rather than stored. Reviewer transport, authentication, HTTP, and malformed-response failures are silent and retry at the next cadence; evidence-read and sink failures degrade visibly.

Long waits have one semantic-review owner per exact child. An active bound supervisor covers its exact target, so that target is omitted from the explicit wait reviewer. Only unsupervised targets receive the existing low-thinking reviewer, and reviewer construction is lazy when every target is covered. Coverage is recomputed at each cadence. A reviewer `unknown` is suppressed only after a fresh exact post-review agent read proves the same occupant is `working`; output metadata alone is insufficient. The latest covered and explicit target partition is exposed as typed `semanticReview` data on `herdr_jobs`, independently from truncatable progress. Supervisor findings remain on the supervisor job and do not settle `wait_result`.

Wakes are advisory. Pi extension hosts wake by steered custom context. MCP hosts route each wake by the manager pane's own agent kind: `devin` and `pi` hosts self-prompt through `agent.prompt`, while `claude` hosts use the Channels notification. Delivery never replaces `herdr_jobs get` as the recovery truth.

`herdr_jobs cancel` is refused with `SUPERVISION_ACTIVE` while an exact or AGY provisional child is live. Manager-session shutdown stops in-memory supervisors. Tools-owned handoff records remain under the endpoint-private state namespace as `recovery_pending`; automatic restoration is a separate follow-up.

The full contract is in [the supervision spec](docs/specs/auto-child-supervision.md) and [ADR-019](docs/decisions/019-automatic-child-supervision.md).

## Run handoff artifact

Every launched child receives one launcher-generated, run-owned Markdown handoff path under the endpoint-private Herdr Tools state namespace. The record has fixed headings (`Status`, `Summary`, `Changes`, `Verification`, `Blockers`, `Continuation`), a `done`/`blocked`/`cancelled`/`failed` status, and `None` when no files changed. Callers never select the path.

This is a Tools-owned orchestration gate, not a Herdr core lifecycle veto. For managed runs, a matching terminal observation remains unaccepted and `herdr_wait` keeps polling until the current artifact validates. `completed` gates both `idle` and `done`; `terminal` gates every terminal outcome. Turn-level cancel or interrupt does not end a run; a runtime-authored cancelled fallback requires confirmed run-level cancellation or authoritative exit. Restart restoration is deferred, so shutdown leaves unresolved records `recovery_pending`. See [ADR-031](docs/decisions/031-universal-disk-handoff.md).

## Configuration

`config.json` is optional and must contain only:

```json
{
  "wait": {
    "reviewCadenceMinutes": 5,
    "reviewerModel": "openai-codex/gpt-6-sol"
  }
}
```

The cadence is an integer from 1 through 30 and is shared by the explicit-wait reviewer and the supervision reviewer. `wait.reviewerModel` is wait-only and uses fixed `low` thinking; the supervision reviewer's model is the code constant `SUPERVISION_REVIEWER_MODEL` (`typesafe/jev-latest`), not a setting. Missing settings use the documented defaults; malformed or invalid settings fail closed.

## Tool examples

```text
herdr_inspect({"mode":"context"})
herdr_inspect({"mode":"target","target":"worker-id"})
herdr_communicate({"target":"worker-id","operation":"prompt","text":"Continue the implementation"})
herdr_communicate({"target":"worker-id","operation":"cancel"})
herdr_communicate({"target":"worker-id","operation":"interrupt"})
herdr_wait({"targets":["worker-id"],"match":"any","condition":{"kind":"state","state":"completed"},"timeoutMs":30000})
herdr_wait({"targets":["worker-id"],"match":"any","condition":{"kind":"state","state":"completed"},"timeoutMs":30000,"label":"worker review"})
herdr_jobs({"operation":"list","operation_phase":"running"})
herdr_launch({"objective":"Inspect the current changes","scope":"Read-only review of the working tree","doneWhen":["Findings reported"],"constraints":["read-only"],"label":"inspect"})
herdr_pane({"operation":"split","label":"worker","direction":"right"})
herdr_tab({"operation":"create","label":"review"})
```

Targets are exact opaque IDs, `current`, exact pane labels, or unique exact agent names where the operation permits. No focused-pane, prefix, display-number, or fuzzy fallback exists. Launch and topology mutations return authoritative post-state, and failed launches retain any resources already created for manual handling.

Communication prompts and launch Task prompts always include the visible `[HERDR AGENT MESSAGE v1]` sender envelope; the caller payload remains unchanged after the envelope blank line. Every launch requires the flat Task — `objective`, `scope`, `doneWhen`, and `constraints` — each field a non-empty string without NUL, extras refused, and no free-form or legacy prompt field. `renderTask` renders the fields in a fixed order as the sender-authored payload, so the same Task always renders byte-identically, and the rendered UTF-8 size is the single authority for the runtime-chosen `inline` or `attachment` delivery bound. AGY and Devin require this Task prompt to be self-contained because they receive no prompt file. Named-key delivery is not wrapped, and there is no provenance opt-out.

Text is submitted exactly once through the protocol-22 native prompt socket. `herdr_communicate` remains non-blocking after its exact identity-bound `agent_prompted` acknowledgement; its working/non-working/unknown observation is diagnostic only. There is no literal `--stdin` route, separate Enter, retry, or fallback. the launch Task prompt has the stronger fail-closed confirmation contract: before submission, one full same-identity `agent get` record must independently report idle with safe `state_change_seq` and `revision`. After acknowledgement, launch polls sequential `agent get` plus `pane get` reads for at most five seconds at 100 ms cadence. Agent-get is the sole coherent lifecycle tuple; pane-get proves identity continuity only. A known working or non-working state confirms only when its sequence strictly advances and its revision is present and non-regressed. Unknown, missing, unchanged, regressed, or same-identity skewed telemetry never confirms. `screen_detection_skipped` is bounded diagnostic metadata only and never validates, confirms, contradicts, or rejects. Timeout, replacement, disappearance, contradiction, read failure, or post-ack abort returns `LAUNCH_FAILED` / `PROMPT_UNCONFIRMED` with bounded submission, baseline, last-state, timing, and created-resource evidence. `PROMPT_UNCONFIRMED` means **not proven, possibly consumed**: tools-only telemetry can false-negative a valid fast turn, so callers must not retry, clean up, register the recipient, or continue dependent work. The confirmation phase never retries prompt or start, and partial resources are never auto-cleaned.

`herdr_communicate` also supports the strict turn-control variants `{"target":"worker","operation":"cancel"}` and `{"target":"worker","operation":"interrupt"}`. They accept no extra fields, require the same authoritative working pane/terminal/full agent-session identity across a snapshot and fresh `agent get`, send exactly one `esc` or `ctrl+c`, wait within the fixed 5,000 ms window, and always perform an independent final snapshot. Same-agent confirmation requires an advanced `state_change_seq`; cancel disappearance is `CANCEL_UNCONFIRMED`. Interrupt can report `agent_exited` only from acknowledged dispatch plus strict agent-free absence proof, reported as `post_dispatch_absence_proven` rather than direct causality. No retries or fallback are used.

`herdr_communicate` also enforces a cooperative caller policy (ADR-030). A pane Herdr launched that manages no children — a leaf worker — may send `prompt`, `steer`, or `kind: "result"` reports only to its recorded manager pane, and may not send `keys`, `cancel`, or `interrupt`. Detected/adopted panes and any pane with launched children are unrestricted; `herdr_inspect` context mode reports the bound `replyPaneId` (or bounded failure evidence) so a worker can discover its reply destination. The restriction is convenience routing for honest agents built on forgeable provenance tokens, not an authorization boundary, and `wait`/`jobs`/`launch`/`pane`/`tab` stay unscoped.

Detached waits show a live Pi footer status with active count and oldest elapsed time. Run `/herdr-waits` to toggle the read-only active-wait widget; each row shows its label, elapsed time, and exact job ID for `herdr_jobs` inspection or cancellation. Labels are optional and are derived from targets plus condition when omitted.

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Unit tests with coverage enforcement |
| `npm run coverage` | Unit coverage and `COVERAGE_RESULT: PASS` |
| `npm run typecheck` | TypeScript check with no emit |
| `npm run build` | TypeScript build check |
| `npm run build:mcp` | Emit `dist/`, including the `dist/src/mcp-server.js` entry the plugin runs |
| `npm run lint` | ESLint |
| `npm run validate:plugin` | `claude plugin validate` on `herdr-profiles/role-plugins/manager/` and `herdr-profiles/profile-plugins/{manager,executor}/` |
| `HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration -- --session herdr-tools-integration` | Preserved original full integration contract for both hosts; **NOTQUALIFIED** by the Pi-only release |
| `HERDR_TOOLS_RUN_INTEGRATION=1 npx --no-install tsx scripts/test-stdin-hotfix.ts --session herdr-tools-pi-hotfix-readback` | Separately named `HOTFIX_PI_ONLY` local socket gate; runs both exact host files with Pi recipients only |

The original integration harness refuses any session name other than `herdr-tools-integration`; the Pi-only hotfix uses only the fresh reserved `herdr-tools-pi-hotfix-readback`. Each rejects reuse of an existing fixture, records failures before teardown, and tears down only IDs returned by that fixture. The MCP suite binds the server to that session's socket; the Pi suite snapshots the default session and asserts its topology is unchanged. Do not run either against the active Courier session.

The Pi-only hotfix is a local release gate, not the original full integration qualification: it preserves the original full-case manifest, refuses missing case/receipt evidence or any nonzero child, and records recipient-generated body hashes, exact identity, native request ID/count, and command exit for its Pi cases: seven-tool smoke, Pi inline launch, normal prompt, steer while working, and complete attachment body. Pi receipts use the extension's wait/job UI path; MCP receipts use detached `herdr_jobs` polling and state the MCP reviewer/push limitations honestly. A failed or uncertain live dispatch retains the named session and recipient for inspection; never retry it or take over an existing session.

## Architecture

- `src/tool-surface.ts` constructs the seven tools once from typed dependencies; both hosts consume it.
- `index.ts` gates registration, builds the `pi.exec` CLI adapter, shares runtime ownership, and clears only in-memory ownership on session shutdown and session start.
- `src/mcp/` holds the MCP host only: startup gating, the `cwd`/`signal` capability proxy, and the bounded process-execution adapter (`host.ts`), schema publication with redacted, parseable, bounded result/error mapping (`adapter.ts`), sequential scheduling for the mutating tools (`queue.ts`), and stdio wiring and lifecycle (`run.ts`). `src/mcp-server.ts` is the argument-free entry emitted to `dist/src/mcp-server.js`.
- `src/redaction.ts` holds the one environment redaction both hosts apply to retained evidence, plus the model-boundary projection the MCP adapter applies again before publishing.
- `herdr-profiles/catalog.yaml` is the reviewed v2 catalog: runner model sets crossed with supported reasoning settings into exact operating points carrying cost/latency classes, runner defaults, resource pools, quota sources, and availability policy inputs that spec evaluation and contract compilation consume.
- `herdr-profiles/role-plugins/manager/` is the self-contained Claude manager plugin: a stable `herdr-tools` manifest, the local MCP server map, and the shared `manager` plus `harness-flow` skills. It carries local MCP registration and manager conduct.
- `src/cli.ts` bounds and validates CLI responses.
- `src/context.ts` resolves the live effective caller context from the injected pane identity and authoritative topology; `src/targets.ts` resolves exact targets against that context.
- `src/tools/` contains the seven public tools. `src/tools/turn-control.ts` owns the internal identity-bound cancel/interrupt protocol. Catalog parsing, candidate compilation, and the typed Pi, Claude, AGY, and Devin argv adapters live under `src/catalog.ts`, `src/compile.ts`, and `src/profiles/`; `herdr_launch` is strict spec-only — every executed child runs a contract compiled from the reviewed catalog (see Spec launches, categories, and candidates).
- `src/reviewer.ts` contains the tool-less in-process model reviewer used by long waits plus the supervision reducer (`reduceSupervisionReview`) and its threshold constants.
- `src/supervision/` owns automatic child supervision: strict validation of every supervision-socket value (`protocol.ts`), the newline-delimited JSON client (`socket.ts`), the one multiplexed session event connection (`monitor.ts`), exact-child pinning and move continuity (`identity.ts`), transitions and soft receipts (`events.ts`), the Jev supervisor reviewer and the retained host-independent model-service seam (`reviewer.ts`, `model-service.ts`), Pi and Claude Channel wakes (`notify.ts`), one child's state machine (`supervisor.ts`), and the reserve/bind/settle coordinator (`registry.ts`). `src/agent-prompt.ts` separately owns the protocol-22 prompt endpoint used by both hosts; neither path falls back to literal stdin.
- `src/wait-jobs-ui.ts` owns session-scoped footer/widget rendering for active detached jobs of both kinds.
- `src/tui.ts` uses Pi `Text` components with bounded semantic rows.

See [ADR-001](docs/decisions/001-extension-runtime-boundary.md) for the runtime boundary and ownership decisions, [ADR-009](docs/decisions/009-shared-claude-mcp-adapter.md) for the shared-implementation MCP adapter, [ADR-010](docs/decisions/010-claude-manager-plugin-conduct.md) for the historical Claude package boundary, [ADR-011](docs/decisions/011-manager-claude-profile-and-plugin-consolidation.md) for the manager plugin layout, [ADR-013](docs/decisions/013-prompt-submission-acknowledgement.md) for single-submit/no-Enter acknowledgement, [ADR-015](docs/decisions/015-semantic-initial-prompt-consumption-confirmation.md) for launch initial-prompt confirmation, [ADR-016](docs/decisions/016-agent-start-budgeted-identity-readiness.md) for coherent readiness, [ADR-017](docs/decisions/017-mcp-live-caller-context-rebinding.md) for live caller-context rebinding, [ADR-019](docs/decisions/019-automatic-child-supervision.md) for automatic child supervision, and [ADR-024](docs/decisions/024-herdr-09-prompt-socket-transport.md) for the local protocol-22 host qualification, and [ADR-030](docs/decisions/030-cooperative-caller-policy.md) for the cooperative worker/manager routing policy, and [ADR-031](docs/decisions/031-universal-disk-handoff.md) for the universal run handoff artifact contract. The focused context contract is in [the MCP context-rebinding spec](docs/specs/mcp-context-rebind.md).
