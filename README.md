# Herdr Tools Pi Extension

A global Pi extension for safe inspection and coordination of Herdr panes, agents, tabs, and topology. It is inert outside a Herdr pane (`HERDR_ENV=1`) and registers exactly seven MCP tools: `herdr_inspect`, `herdr_communicate`, `herdr_wait`, `herdr_jobs`, `herdr_launch`, `herdr_pane`, and `herdr_tab`.

`herdr_wait` is the MCP state/output wait tool. It is not a CLI lifecycle command: CLI readiness uses `herdr agent wait`, while output conditions are evaluated from authoritative pane output.

## Quick start

```bash
cd /home/gabriel/.pi/agent/extensions/herdr-tools
npm install
cp config.json.example config.json # optional; edit only extension-owned wait settings
```

Pi discovers the directory through its root `index.ts` when it is installed at `/home/gabriel/.pi/agent/extensions/herdr-tools/`. The installed `herdr` CLI is the only Herdr authority. The extension never intercepts raw Herdr Bash and never launches an arbitrary executable.

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

The cadence is an integer from 1 through 30. A configured reviewer uses fixed `low` thinking. Missing settings use the documented defaults; malformed or invalid settings fail closed.

## Tool examples

```text
herdr_inspect({"mode":"context"})
herdr_inspect({"mode":"target","target":"worker-id"})
herdr_communicate({"target":"worker-id","operation":"prompt","text":"Continue the implementation"})
herdr_wait({"targets":["worker-id"],"match":"any","condition":{"kind":"state","state":"completed"},"timeoutMs":30000})
herdr_wait({"targets":["worker-id"],"match":"any","condition":{"kind":"state","state":"completed"},"timeoutMs":30000,"label":"worker review","runInBackground":true})
herdr_jobs({"operation":"list","status":"running"})
herdr_launch({"name":"reviewer","profile":"reviewer-pi","initialPrompt":"Inspect the current changes"})
herdr_pane({"operation":"split","label":"worker","direction":"right"})
herdr_tab({"operation":"create","label":"review"})
```

Targets are exact opaque IDs, `current`, exact pane labels, or unique exact agent names where the operation permits. No focused-pane, prefix, display-number, or fuzzy fallback exists. Launch and topology mutations return authoritative post-state, and failed launches retain any resources already created for manual handling.

Communication prompts and launch initial prompts always include the visible `[HERDR AGENT MESSAGE v1]` sender envelope; the caller payload remains unchanged after the envelope blank line. Named-key delivery is not wrapped, and there is no provenance opt-out.

Detached waits show a live Pi footer status with active count and oldest elapsed time. Run `/herdr-waits` to toggle the read-only active-wait widget; each row shows its label, elapsed time, and exact job ID for `herdr_jobs` inspection or cancellation. Labels are optional and are derived from targets plus condition when omitted.

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Unit tests with coverage enforcement |
| `npm run coverage` | Unit coverage and `COVERAGE_RESULT: PASS` |
| `npm run build` | TypeScript build check |
| `npm run lint` | ESLint |
| `HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration -- --session herdr-tools-integration` | Opt-in disposable-session smoke test |

The integration harness refuses any session name other than `herdr-tools-integration`, rejects reuse of an existing fixture, records failures before teardown, and tears down only IDs returned by that fixture. Do not run it against the active Courier session.

## Architecture

- `index.ts` gates registration, builds the `pi.exec` CLI adapter, shares runtime ownership, and clears only in-memory ownership on session shutdown and session start.
- `src/cli.ts` bounds and validates CLI responses.
- `src/targets.ts` resolves exact targets and injected current context.
- `src/tools/` contains the seven public tools. Profile discovery and typed Pi/Claude adapters live under `src/profiles/`; `herdr_launch` is strict profile-only: no profile, no launch.
- `src/reviewer.ts` contains the tool-less in-process model reviewer used by long waits.
- `src/wait-jobs-ui.ts` owns session-scoped footer/widget rendering for active detached waits.
- `src/tui.ts` uses Pi `Text` components with bounded semantic rows.

See [ADR-001](docs/decisions/001-extension-runtime-boundary.md) for the runtime boundary and ownership decisions.
