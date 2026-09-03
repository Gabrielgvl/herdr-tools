# Spec: Profile-backed Herdr delegation

## Objective

Replace the normal `pi-subagents` delegation path with visible, pane-backed Pi, Claude, and AGY agents launched from reusable profiles. Build it in working layers rather than coupling the first release to every lifecycle feature.

The first implementation slice delivers a strict profile catalog and profile-backed launch that can be dogfooded immediately. It also gives each bundled role an explicit capability policy and one shared role skill across Pi and Claude, with `manager-pi` as the generic advisory manager and `manager-claude` as the explicit Claude/Fable manager and succession profile. Later slices add Herdr-native turn results, same-pane replacement, durable run state, and the blocking `herdr_delegate` lifecycle tool. `pi-subagents` remains installed only until the acceptance gates for the complete replacement pass.

## Validated product decisions

- Profiles are owned and resolved by `herdr-tools`, not the Herdr runtime.
- Bundled profiles use deliberate role-scoped capabilities. `manager-pi` orchestrates visible workers without direct mutation tools; `manager-claude` uses Claude `default` permission mode with only its core/research/Herdr namespace pre-approved and only `Task` hard-denied, so Bash/Edit/Write remain owner-gated; scout, planner, reviewer, and researcher do not mutate repository state; worker is the only bundled role with pre-approved direct content mutation and background-job tools; promoter has Bash but may mutate only the reviewed Git index/ref metadata and ignored harness receipts needed to create the exact approved commit.
- Profiles are separate Markdown files discovered from:
  1. bundled `herdr-profiles/*.md`;
  2. user `~/.pi/agent/herdr-profiles/*.md`;
  3. nearest project `.pi/herdr-profiles/*.md`.
- Exact-name precedence is project > user > bundled; the winning file replaces the whole lower-precedence profile.
- Files use strict YAML 1.2 frontmatter and a required literal Markdown body. No interpolation, includes, inheritance, environment expansion, or raw argv.
- Filename stem must equal a required lowercase kebab-case `name`; `description`, exact `model`, `kind`, and kind-specific reasoning are required.
- Each profile pins exactly one kind (`pi`, `claude`, or `agy`) through a discriminated runtime block. Pi and Claude bodies are appended through their existing system-prompt channels. An AGY body is catalog metadata only and never reaches the runtime.
- Claude and AGY profiles must set `sessionPersistence: true` because Herdr starts interactive agents. Pi profiles may set it false and receive `--no-session`.
- Relative runtime-resource paths resolve from the profile scope root. Arbitrary environment overrides are not supported by profile delegation.
- Pi and Claude profile bodies are stored as durable owner-only prompt sources before topology mutation. The source is a UTF-8 exact-body SHA-256 content-addressed file under the Herdr-tools cache directory (`0700` directory, `0600` file), reused across launches and restarts; successful sources are never deleted.
- Typed call overrides may replace typed defaults, including capability-expanding Claude permission modes. Project profiles have no trust gate. These are deliberate trust choices.
- Fallbacks are ordered references to named profiles, validated as a graph. A launch has at most three attempts. Invalid profiles are isolated; only the selected reachable graph blocks launch.
- Automatic fallback is allowed only after the installed CLI failure envelope `{id:"cli:agent:start",error:{code:"agent_start_failed",message:"agent process exited before becoming interactive"}}` with non-killed exit 1 and untruncated stderr, followed by an authoritative pane read with `agent_status:"unknown"` and no agent identity/session fields. Timeout, malformed protocol, identity, kind, prompt, provisional supervision, strengthening, and uncertain-state failures stop. After any possible prompt effect, launch never retries, falls back, cleans up, or releases the recovery handle.
- Fallback targets use their own untouched defaults. Typed overrides apply only to the requested primary. The logical cwd, task, placement, and provenance carry across attempts.
- Bundled roles are `manager`, `scout`, `planner`, `worker`, `reviewer`, `researcher`, and `promoter`. `manager-pi` uses `openai-codex/gpt-5.6-sol` with high thinking as the generic advisory profile. `manager-claude` uses `claude-fable-5` with high effort, default permission mode, persistent session state, the manager plugin, and no fallback because manager identity must not silently change. The other role directions and models are:
  - scout: `openai-codex/gpt-5.6-luna` -> `claude-sonnet-5`;
  - researcher: `gemini-3.8-flash-high` -> `openai-codex/gpt-5.6-luna` -> `claude-sonnet-5`;
  - worker: `openai-codex/gpt-5.6-luna` with max thinking -> `claude-opus-5`;
  - reviewer: `openai-codex/gpt-5.6-sol` -> `claude-opus-5`;
  - planner: `claude-fable-5` -> `openai-codex/gpt-5.6-sol`.
  - promoter: `openai-codex/gpt-5.6-luna` -> `claude-opus-5`.
  AGY research uses fixed plan mode and permission bypass. The existing Pi and Claude profile claims remain unchanged.
- Every bundled Pi and Claude profile has one role-scoped skill; `manager-pi` additionally loads the cross-role `harness-flow` skill. Claude profiles load the corresponding scope-local plugin directory; Pi profiles load the same skill path directly. Normal installed extension discovery remains enabled, while profile allowlists omit hidden delegation, durable-memory mutation, and unapproved lifecycle capabilities.
- Bundled role bodies are rewritten for Herdr; they do not preserve chain, artifact, fork, or `pi-subagents` implementation assumptions.

## Layered delivery

### Slice 1: Catalog and profile-backed launch

Deliver now:

- strict schema/parser and scoped discovery;
- deterministic whole-profile precedence and graph validation;
- bounded `herdr_inspect` profile collection/exact-profile modes; collection omissions expose `truncated`, exact whole-item `omittedCount`, exact diagnostic `diagnosticOmittedCount`, and an `OUTPUT_TRUNCATED` diagnostic in both details and model-visible JSON. Catalogs also retain the total generated diagnostic count even when retained diagnostics are capped;
- typed Pi, Claude, and AGY argv adapters;
- profile-backed launch through the existing launch implementation while preserving mandatory assignment provenance;
- starter bundled profiles, shared role plugins and skills, explicit Pi and Claude capability matrices, the AGY researcher contract, and unit tests;
- bounded automatic fallback for the exact pre-interactive process-exit error and authoritative no-agent proof; all other failures stop and return bounded attempt evidence.

This slice must not pretend terminal transcript scraping is a structured result.

### Locked profile-only launch contract

`herdr_launch` has one public mode: `{name, profile, overrides?, placement?, label?, cwd?, focus?, initialPrompt?}`. Raw `kind`, `argv`, and `env` fields are rejected. Profile discovery remains rooted at the manager session cwd and accepts arbitrary valid named profiles.

The advisory role defaults are: manager-pi for generic management, worker-pi for implementation, planner-claude first with planner-pi fallback for planning, scout-agy for reconnaissance, researcher-agy for research, and reviewer-pi for review. The explicit `harness-flow` overrides those generic defaults with Pi-first `scout-pi`, `researcher-pi`, `planner-pi`, `worker-pi`, `reviewer-pi`, and `promoter-pi`; its promoter chain is `promoter-pi -> promoter-claude`. The exact AGY chains are `scout-agy -> scout-pi -> scout-claude` and `researcher-agy -> researcher-pi -> researcher-claude`; the implementation chain is `worker-pi -> worker-agy -> worker-claude`. Select manager-claude when the owner requests Claude/Fable management or Claude-to-Claude succession. These defaults do not restrict arbitrary valid profile selection. Primary-only typed overrides never leak into fallback profiles. Profile `timeoutMinutes` is task policy; Herdr startup uses a separate valid 120000 ms readiness timeout and a small CLI execution margin.

AGY accepts only `model` and scope-normalized `addDirs` overrides. Its argv is fixed to `--model <model> --mode <profile.mode> --dangerously-skip-permissions`, with required fixed `mode` exactly `plan` or `accept-edits`; mode is not launch-overrideable. Researcher and scout profiles use `plan`; the worker profile uses `accept-edits`. The declared add directories and the Herdr-Tools-owned recipient attachment directory follow. It accepts no prompt file, raw argv, arbitrary environment, or promptless launch. The required `initialPrompt` is visible, provenance-wrapped, and self-contained because the profile body remains metadata and AGY receives repository `AGENTS.md` only through native discovery. The worker's accept-edits mode plus permission bypass can auto-approve mutations, so manager assignments must bound scope and tests.

Launch details include requested and selected profile names, effective runtime, model, source, timeout, permissions, bounded per-attempt evidence, and prompt confirmation evidence. Pi and Claude retain complete native-session readiness before dispatch or promptless success.

AGY alone may publish a running, live, non-cancellable `provisional` supervisor after one coherent idle sample proves pane, terminal, name, kind, sequence, and revision without a native session. It then submits the mandatory envelope exactly once and requires the official full native `agent_session`, lifecycle advancement, and non-regressed revision within the existing five-second confirmation window. One observer-backed transaction drains provisional events before atomically publishing exact `active` or `degraded` coverage. Recipients and attachments remain unavailable until strengthening and semantic assignment confirmation both succeed.

This provisional window carries an AGY-only reduced-assurance risk: pane, terminal, name, and kind continuity is not cryptographic attribution. A same-terminal replacement or stale report can be misattributed until exact strengthening. This AGY runtime support is a Herdr Tools-only change. Herdr Tools bounds but cannot eliminate that risk without a Herdr Core change. Pi and Claude remain strict. Any possible prompt effect followed by acknowledgement, transport, identity, read, timeout, or strengthening failure leaves the provisional supervisor and child visible and performs no retry, fallback, cleanup, reservation release, or recipient registration. The only fallback remains the exact pre-interactive no-agent case.

### Slice 2: Herdr runtime prerequisites

Add to Herdr core and managed Pi/Claude integrations:

- stdin prompt transport with a 64 KiB task limit;
- authoritative turn IDs and structured turn-result events;
- structured provider failure classification;
- exact turn cancellation;
- same-pane native `agent replace` preserving scrollback;
- durable logical-run lineage and exact identity reconciliation;
- owner-only local result/transcript storage with unguessable bearer refs.

### Slice 3: Blocking delegate lifecycle

Add `herdr_delegate` as a blocking high-level tool:

- creates only owned no-focus worker panes on worker tabs separate from the manager/caller tab; a right-side split is permitted only when adding another worker pane to an existing worker tab with fewer than three panes; the manager/caller tab is never used;
- one logical 1-60 minute deadline, profile default 30 minutes;
- eligible fallback on structured quota/rate-limit/overload/model-provider capacity failures;
- continuation after prior activity uses a low-thinking direct model summary (default exact Luna) plus a Herdr `transcriptRef`;
- original sender remains the mandatory outer provenance; handoff summary provenance is nested and explicitly not user/owner authority;
- blocked runs return `needs_input` plus durable bearer `runRef` and support resume/cancel from any Herdr pane;
- configurable nesting depth 1-4, default 2, with leaf-first cancellation;
- verified complete results close unfocused success panes; failures, cancellations, storage failures, focused successes, and incomplete delivery retain panes.

### Slice 4: Acceptance and cutover

- Dogfood the bundled Luna profiles for implementation/review work.
- Complete unit, integration, and disposable-session end-to-end tests.
- Remove/disable `pi-subagents` only after the replacement gates pass.
- Do not add compatibility parsing for old profiles.

## Tech stack

- TypeScript 5.9, TypeBox, Pi extension APIs, Herdr CLI JSON contracts.
- Add the maintained `yaml` package for strict YAML parsing; do not extend the old flat parser.
- Rust changes belong in the Herdr repository and must expose authoritative CLI/API evidence.

## Commands

```bash
npm run test:unit
npm run typecheck
npm run lint
npm run build
HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration
```

Herdr runtime verification uses its repository's documented `cargo fmt`, `cargo clippy`, and `cargo test` commands.

## Project structure

```text
herdr-profiles/             bundled profile Markdown files
src/profiles/               schema, parser, discovery, resolution, adapters
test/unit/profiles/         parser/discovery/graph/adapter tests
src/tools/inspect.ts        profile catalog inspection modes
src/tools/launch.ts         low-level profile-backed launch integration
src/tools/delegate.ts       later blocking lifecycle tool
herdr-profiles/role-plugins/ shared role skills and Claude plugin manifests
docs/specs/                 living implementation specifications
docs/decisions/             architecture decisions
```

## Code style

Use strict discriminated data and fail closed:

```ts
type RuntimeProfile =
  | { kind: "pi"; pi: PiRuntimeConfig; claude?: never }
  | { kind: "claude"; claude: ClaudeRuntimeConfig; pi?: never };

function resolveProfile(name: string, catalog: ProfileCatalog): ResolvedProfile {
  const profile = catalog.effective.get(name);
  if (!profile) throw new ProfileError("Unknown profile", { name });
  return validateReachableGraph(profile, catalog, 3);
}
```

Reject unknown fields, ambiguity, cycles, malformed paths, oversized files, and incompatible kind fields. Never silently infer legacy values.

## Testing strategy

- Unit-test parsing, schema rejection, precedence, shadow reporting, graph cycles/missing targets/max attempts, path resolution, argument generation, bounds, and redaction.
- Assert the 15 bundled profiles, exact scout/researcher/worker chains and per-profile fixed AGY argv, exact manager-claude and role capability matrices, shared resource paths, no hidden delegation tools, read-only mutation exclusions, and representative Pi, Claude, and AGY launch flags.
- Unit-test launch ordering: resolve -> create pane/tab -> start exact kind/argv -> readiness -> provenance assignment.
- Integration-test in a disposable Herdr session; never mutate or close the active user workspace.
- Runtime work requires Pi and Claude contract tests for result correlation, cancellation, replacement, restart reconciliation, and capacity/storage failures.
- Dogfood only after unit/type/lint/build gates pass for the slice.

## Boundaries

### Always

- Use exact Herdr IDs and authoritative post-state.
- Preserve mandatory visible inter-agent provenance.
- Keep task/system instructions in separate channels.
- Keep partial failures visible and return bounded diagnostics.
- Commit each tested slice separately.

### Ask first

- Installing or upgrading global integrations outside the explicit delegate auto-update path.
- Removing `pi-subagents` before the acceptance gates pass.
- Raising task/result/storage bounds.
- Changing the chosen trust model or permission-bypass behavior.

### Never

- Scrape terminal text and label it a structured result.
- Use transcript regexes to classify quota/provider failures.
- Pass raw argv or arbitrary env through profile-backed delegation.
- Auto-close caller-owned/existing panes.
- Add old-profile compatibility or fallback behavior that hides invalid configuration.

## Slice 1 success criteria

- [ ] Seventeen bundled profiles resolve deterministically with source and shadow evidence; `manager-pi` remains the generic advisory manager and `manager-claude` is selected for explicit Claude/Fable management or Claude-to-Claude succession; both have no fallback.
- [ ] Every bundled role has one shared role skill, with matching Pi skill and Claude plugin resources; the manager plugin also carries the cross-role `harness-flow` skill.
- [ ] Pi and Claude capability matrices exclude hidden delegation, keep direct content mutation tools limited to workers, and limit promoter mutation to reviewed Git metadata and ignored harness receipts.
- [ ] Invalid unrelated profiles do not block valid profiles; invalid reachable fallback graphs fail before launch.
- [ ] Exact profile inspection is bounded and redacts sensitive runtime values.
- [ ] Pi and Claude adapters produce typed, shell-free argv with appended-system-prompt semantics; AGY produces fixed plan and permission-bypass argv without a profile-body prompt source.
- [ ] Profile-backed launch works in a disposable Herdr session and preserves the v1 assignment envelope.
- [ ] At least one bundled Luna profile is used to perform real repository work after deployment.
- [ ] Unit, typecheck, lint, build, and integration gates are green.

## Open questions deferred beyond Slice 1

- Exact Herdr core event/result schema and persistence database format.
- Exact Pi/Claude integration hooks needed to classify provider failures without text heuristics.
- Direct summarizer JSON schema and transcript compaction algorithm.
- Terminal retained-result eviction implementation details.
