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

## Claude Fable manager

A Claude Fable session running in a Herdr pane can act as the manager through the local stdio MCP server. Build the server, add the bundled marketplace, install the plugin globally for the user, then restart Claude:

```bash
cd /home/gabriel/.pi/agent/extensions/herdr-tools
npm run build:mcp
claude plugin marketplace add /home/gabriel/.pi/agent/extensions/herdr-tools --scope user
claude plugin install herdr-tools@herdr-tools --scope user -y
claude --model claude-fable-5
```

`/mcp` must list the `herdr` server with the seven tools as `mcp__plugin_herdr-tools_herdr__herdr_inspect` through `mcp__plugin_herdr-tools_herdr__herdr_tab`. The bundled `manager-claude` profile uses this same plugin and is selected for owner-requested Claude/Fable management or Claude-to-Claude succession; `manager-pi` remains the generic advisory default. Inside a running session the owner switches models with `/model fable`; the packaged skill reports a mismatch and stops rather than claiming enforcement.

Startup is fail-closed. The server refuses to serve unless `HERDR_ENV=1`, the injected `HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`/`HERDR_PANE_ID` identity is present and valid, and `CLAUDE_PROJECT_DIR` is an absolute path to an existing directory. Claude Code exports `CLAUDE_PROJECT_DIR` to MCP server subprocesses, so no environment mapping is configured; the subprocess working directory, the plugin directory, and module-relative paths are never used as a substitute.

### Caller context after pane moves

Injected Herdr IDs are bootstrap identity. Before each context-dependent tool call, the server reads `herdr pane current --current`, using the injected pane identity as the selection anchor, then verifies the returned effective pane against one authoritative `herdr api snapshot`. Herdr may return a new public pane ID for an old pane alias. When that happens, both records must carry the same terminal identity. The live tab and workspace IDs become the effective context. This lets the tools survive a same-workspace tab move or a cross-workspace move when Herdr still resolves the original pane alias.

`herdr_inspect` with `mode: "context"` reports `context.injected`, `context.effective`, and `context.rebound`. Other successful calls include bounded `contextRebinding` evidence only when a rebind occurred. Missing or malformed IDs, a missing or duplicate caller pane, incoherent parent relationships, pane replacement, protocol errors, and a topology that keeps changing fail closed. A small retry is used only for a concurrent live-read and snapshot race. Health continues to report syntactic environment presence and validity, so stale ancestor IDs are not falsely reported as malformed.

Model-visible content is bounded and redacted at the boundary: `details` and typed error evidence pass through one recursive projection that drops, at every depth, any environment-shaped key whose value could hold an environment value, oversized evidence becomes a parseable `{"truncated":true,"originalBytes":n,"preview":"…"}` envelope instead of a cut string, and a `herdr` call that floods a pipe past 1 MiB fails with `CLI_OUTPUT_OVERFLOW` rather than growing the server's memory. `herdr_communicate`, `herdr_pane`, and `herdr_tab` are serialized per session exactly as Pi schedules them, so two overlapping mutations cannot interleave; inspect, wait, and jobs stay concurrent.

Two host differences are deliberate:

- **Waits are detached and polled.** Every `herdr_wait` call performs its validation and target/context preflight, registers a session-scoped background job, and returns immediately with an opaque ID. Poll jobs with `herdr_jobs` `list` and `get`; cancel only through `herdr_jobs` `cancel`. Pi retains its existing terminal notification and active-wait UI, while the MCP host has no push notification.
- **No model-backed wait review on MCP.** The MCP host has no model registry, so a job whose timeout exceeds `wait.reviewCadenceMinutes` fails closed with `REVIEWER_FAILED` in its `herdr_jobs` result. Use repeated bounded waits, or raise the cadence (maximum 30) in `config.json`.

For refreshes, rebuild main, update the user-installed plugin, and restart Claude:

```bash
cd /home/gabriel/.pi/agent/extensions/herdr-tools
npm run build:mcp
claude plugin update herdr-tools@herdr-tools --scope user -y
```

The cached plugin intentionally points back to `/home/gabriel/.pi/agent/extensions/herdr-tools/dist/src/mcp-server.js`, so main installed at that path must be built. For development or sideloading, `claude --plugin-dir /home/gabriel/.pi/agent/extensions/herdr-tools/herdr-profiles/role-plugins/manager` remains an explicit alternative to the global marketplace installation.

## Automatic child supervision

A supervisor exists from the moment a child exists, including a launch with no `initialPrompt` and a launch into an existing pane. `herdr_launch` reserves it before its first topology mutation and binds it only after the exact launch identity is proven and, when a prompt was sent, after prompt consumption is confirmed. A launch that cannot bind a supervisor fails with `SUPERVISION_UNCONFIRMED` as a partial effect: the child is left alone, nothing is retried, and nothing is cleaned up. A successful launch returns the supervisor's stable job ID.

Supervision watches the Herdr lifecycle stream directly. It holds **one** long-lived connection to `HERDR_SOCKET_PATH` for the whole session carrying a single acknowledged `events.subscribe`; Herdr 0.8.2 answers exactly one request per connection, so the subscription set is fixed and global, every supervisor is multiplexed over it, and each `session.snapshot` is a separate short-lived read taken only when something needs one. The child is pinned by `terminal_id` plus the whole `agent_session` and anchored on the pane `revision` its bind snapshot observed, because Herdr reuses pane IDs. A pane move is followed only on atomic evidence plus a fresh matching occupant, and replay deduplication uses the connection's event ordinal so a move cannot leave a supervisor silently blind. Every accepted event is validated on its own fields at the protocol boundary; a malformed one drops the connection instead of disappearing. On reconnect a supervisor resumes silently only when the fresh snapshot proves nothing advanced; otherwise it emits one high-priority `evidence_gap` and keeps going. There is no polling fallback: a socket that cannot be restored leaves the supervisor visibly degraded.

Working starts are silent. The manager is woken for a completed work cycle, a block, reviewer attention, reviewer degradation and recovery, identity replacement or loss, release, pane close, monitor health changes, and an evidence gap. A child that has been working continuously for the configured cadence is reviewed with exactly `openai-codex/gpt-5.6-luna` at thinking `max` — separate from the explicit-wait reviewer, which stays Luna at `low`. Each review sees only what is new since the previous one, and a review whose work cycle ends mid-flight is abandoned rather than stored. Reviewer failure degrades visibly once and retries at the next cadence.

Wakes are best effort and never retried. Pi wakes by steered custom context. Claude wakes through the Claude Code Channels research preview served by the same MCP server, which advertises `capabilities.experimental["claude/channel"]` and sends `notifications/claude/channel`; `manager-claude` opts in locally with `--dangerously-load-development-channels server:herdr`, and the organization's `channelsEnabled` policy still applies. Nothing is lost when a wake does not arrive: every material event carries an opaque ID, `herdr_jobs get` returns the pending ones and marks exactly those observed, and `herdr_jobs list` and the active-job footer show unobserved counts.

`herdr_jobs cancel` is refused with `SUPERVISION_ACTIVE` while the exact child is live. Manager-session shutdown cancels supervisors, and nothing persists across sessions.

The full contract is in [the supervision spec](docs/specs/auto-child-supervision.md) and [ADR-019](docs/decisions/019-automatic-child-supervision.md).

## Configuration

`config.json` is optional and must contain only:

```json
{
  "wait": {
    "reviewCadenceMinutes": 5,
    "reviewerModel": "openai-codex/gpt-5.6-luna"
  }
}
```

The cadence is an integer from 1 through 30 and is shared by the explicit-wait reviewer and the supervision reviewer. `wait.reviewerModel` is wait-only and uses fixed `low` thinking; the supervision reviewer pins `openai-codex/gpt-5.6-luna` at `max` in code. Missing settings use the documented defaults; malformed or invalid settings fail closed.

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
herdr_launch({"name":"reviewer","profile":"reviewer-pi","initialPrompt":"Inspect the current changes"})
herdr_pane({"operation":"split","label":"worker","direction":"right"})
herdr_tab({"operation":"create","label":"review"})
```

Targets are exact opaque IDs, `current`, exact pane labels, or unique exact agent names where the operation permits. No focused-pane, prefix, display-number, or fuzzy fallback exists. Launch and topology mutations return authoritative post-state, and failed launches retain any resources already created for manual handling.

Communication prompts and launch initial prompts always include the visible `[HERDR AGENT MESSAGE v1]` sender envelope; the caller payload remains unchanged after the envelope blank line. Named-key delivery is not wrapped, and there is no provenance opt-out.

Text is submitted exactly once through stdin. `herdr_communicate` remains non-blocking after its exact identity-bound `agent_prompted` acknowledgement; its working/non-working/unknown observation is diagnostic only. `herdr_launch.initialPrompt` has the stronger fail-closed assignment contract: before submission, one full same-identity `agent get` record must independently report idle with safe `state_change_seq` and `revision`. After acknowledgement, launch polls sequential `agent get` plus `pane get` reads for at most five seconds at 100 ms cadence. Agent-get is the sole coherent lifecycle tuple; pane-get proves identity continuity only. A known working or non-working state confirms only when its sequence strictly advances and its revision is present and non-regressed. Unknown, missing, unchanged, regressed, or same-identity skewed telemetry never confirms. `screen_detection_skipped` is bounded diagnostic metadata only and never validates, confirms, contradicts, or rejects. Timeout, replacement, disappearance, contradiction, read failure, or post-ack abort returns `LAUNCH_FAILED` / `PROMPT_UNCONFIRMED` with bounded submission, baseline, last-state, timing, and created-resource evidence. `PROMPT_UNCONFIRMED` means **not proven, possibly consumed**: tools-only telemetry can false-negative a valid fast turn, so callers must not retry, clean up, register the recipient, or continue dependent work. The confirmation phase never retries prompt or start, and partial resources are never auto-cleaned.

`herdr_communicate` also supports the strict turn-control variants `{"target":"worker","operation":"cancel"}` and `{"target":"worker","operation":"interrupt"}`. They accept no extra fields, require the same authoritative working pane/terminal/full agent-session identity across a snapshot and fresh `agent get`, send exactly one `esc` or `ctrl+c`, wait within the fixed 5,000 ms window, and always perform an independent final snapshot. Same-agent confirmation requires an advanced `state_change_seq`; cancel disappearance is `CANCEL_UNCONFIRMED`. Interrupt can report `agent_exited` only from acknowledged dispatch plus strict agent-free absence proof, reported as `post_dispatch_absence_proven` rather than direct causality. No retries or fallback are used.

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
| `npm run validate:plugin` | `claude plugin validate` on `herdr-profiles/role-plugins/manager/` |
| `HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration -- --session herdr-tools-integration` | Opt-in disposable-session smoke tests for both hosts |

The integration harness refuses any session name other than `herdr-tools-integration`, rejects reuse of an existing fixture, records failures before teardown, and tears down only IDs returned by that fixture. The MCP suite additionally binds the server to that session's socket and asserts the default session's topology is unchanged. Do not run it against the active Courier session.

## Architecture

- `src/tool-surface.ts` constructs the seven tools once from typed dependencies; both hosts consume it.
- `index.ts` gates registration, builds the `pi.exec` CLI adapter, shares runtime ownership, and clears only in-memory ownership on session shutdown and session start.
- `src/mcp/` holds the MCP host only: startup gating, the `cwd`/`signal` capability proxy, and the bounded process-execution adapter (`host.ts`), schema publication with redacted, parseable, bounded result/error mapping (`adapter.ts`), sequential scheduling for the mutating tools (`queue.ts`), and stdio wiring and lifecycle (`run.ts`). `src/mcp-server.ts` is the argument-free entry emitted to `dist/src/mcp-server.js`.
- `src/redaction.ts` holds the one environment redaction both hosts apply to retained evidence, plus the model-boundary projection the MCP adapter applies again before publishing.
- `herdr-profiles/role-plugins/manager/` is the self-contained Claude manager plugin: a stable `herdr-tools` manifest, the `herdr` stdio server map, and the shared `skills/manager/SKILL.md`. It carries the local MCP registration and manager conduct, while the profile keeps permissions explicit and owner-gated.
- `src/cli.ts` bounds and validates CLI responses.
- `src/context.ts` resolves the live effective caller context from the injected pane identity and authoritative topology; `src/targets.ts` resolves exact targets against that context.
- `src/tools/` contains the seven public tools. `src/tools/turn-control.ts` owns the internal identity-bound cancel/interrupt protocol. Profile discovery and typed Pi/Claude adapters live under `src/profiles/`; `herdr_launch` is strict profile-only: no profile, no launch.
- `src/reviewer.ts` contains the tool-less in-process model reviewer used by long waits.
- `src/supervision/` owns automatic child supervision: strict validation of every socket value (`protocol.ts`), the newline-delimited JSON client (`socket.ts`), the one multiplexed session event connection (`monitor.ts`), exact-child pinning and move continuity (`identity.ts`), transitions and soft receipts (`events.ts`), the Luna-max supervisor reviewer and its host-independent model service (`reviewer.ts`, `model-service.ts`), Pi and Claude Channel wakes (`notify.ts`), one child's state machine (`supervisor.ts`), and the reserve/bind/settle coordinator (`registry.ts`). This is the only module that touches the Herdr socket, and it is read-only.
- `src/wait-jobs-ui.ts` owns session-scoped footer/widget rendering for active detached jobs of both kinds.
- `src/tui.ts` uses Pi `Text` components with bounded semantic rows.

See [ADR-001](docs/decisions/001-extension-runtime-boundary.md) for the runtime boundary and ownership decisions, [ADR-009](docs/decisions/009-shared-claude-mcp-adapter.md) for the shared-implementation MCP adapter, [ADR-010](docs/decisions/010-claude-manager-plugin-conduct.md) for the historical Claude package boundary, [ADR-011](docs/decisions/011-manager-claude-profile-and-plugin-consolidation.md) for the current manager profile and plugin layout, [ADR-015](docs/decisions/015-semantic-initial-prompt-consumption-confirmation.md) for launch initial-prompt confirmation, [ADR-017](docs/decisions/017-mcp-live-caller-context-rebinding.md) for live caller-context rebinding, and [ADR-019](docs/decisions/019-automatic-child-supervision.md) for automatic child supervision. The focused context contract is in [the MCP context-rebinding spec](docs/specs/mcp-context-rebind.md).
