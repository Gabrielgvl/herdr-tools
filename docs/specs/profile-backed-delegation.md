# Spec: Profile-backed Herdr delegation

## Objective

Replace the normal `pi-subagents` delegation path with visible, pane-backed Pi and Claude agents launched from reusable profiles. Build it in working layers rather than coupling the first release to every lifecycle feature.

The first implementation slice delivers a strict profile catalog and profile-backed launch that can be dogfooded immediately. Later slices add Herdr-native turn results, same-pane replacement, durable run state, and the blocking `herdr_delegate` lifecycle tool. `pi-subagents` remains installed only until the acceptance gates for the complete replacement pass.

## Validated product decisions

- Profiles are owned and resolved by `herdr-tools`, not the Herdr runtime.
- Profiles are separate Markdown files discovered from:
  1. bundled `herdr-profiles/*.md`;
  2. user `~/.pi/agent/herdr-profiles/*.md`;
  3. nearest project `.pi/herdr-profiles/*.md`.
- Exact-name precedence is project > user > bundled; the winning file replaces the whole lower-precedence profile.
- Files use strict YAML 1.2 frontmatter and a required literal Markdown body. No interpolation, includes, inheritance, environment expansion, or raw argv.
- Filename stem must equal a required lowercase kebab-case `name`; `description`, exact `model`, `kind`, and kind-specific reasoning are required.
- Each profile pins exactly one kind (`pi` or `claude`) through a discriminated runtime block. The body is appended to the runtime's default system prompt.
- Claude profiles must set `sessionPersistence: true` because Herdr starts interactive Claude agents; Pi profiles may set it false and receive `--no-session`.
- Relative runtime-resource paths resolve from the profile scope root. Arbitrary environment overrides are not supported by profile delegation.
- Profile bodies are stored as durable owner-only prompt sources before topology mutation. The source is a UTF-8 exact-body SHA-256 content-addressed file under the Herdr-tools cache directory (`0700` directory, `0600` file), reused across launches and restarts; successful sources are never deleted.
- Typed call overrides may replace typed defaults, including capability-expanding Claude permission modes. Project profiles have no trust gate. These are deliberate trust choices.
- Fallbacks are ordered references to named profiles, validated as a graph. A logical run has at most three attempts. Invalid profiles are isolated; only the selected reachable graph blocks launch.
- Fallback targets use their own defaults. The logical cwd, task, placement, and provenance carry across attempts.
- Bundled roles are `scout`, `planner`, `worker`, `reviewer`, and `researcher`, with Pi and Claude variants. Bundled direction/model policy:
  - scout: `openai-codex/gpt-5.6-luna` -> `claude-sonnet-5`;
  - researcher: `openai-codex/gpt-5.6-luna` -> `claude-sonnet-5`;
  - worker: `openai-codex/gpt-5.6-luna` -> `claude-opus-5`;
  - reviewer: `openai-codex/gpt-5.6-sol` -> `claude-opus-5`;
  - planner: `claude-fable-5` -> `openai-codex/gpt-5.6-sol`.
- Bundled role bodies are rewritten for Herdr; they do not preserve chain, artifact, fork, or `pi-subagents` implementation assumptions.

## Layered delivery

### Slice 1: Catalog and profile-backed launch

Deliver now:

- strict schema/parser and scoped discovery;
- deterministic whole-profile precedence and graph validation;
- bounded `herdr_inspect` profile collection/exact-profile modes; collection omissions expose `truncated`, `omittedCount`, and an `OUTPUT_TRUNCATED` diagnostic in both details and model-visible JSON;
- typed Pi and Claude argv adapters;
- profile-backed launch through the existing launch implementation while preserving mandatory assignment provenance;
- starter bundled profiles and unit tests;
- no automatic fallback yet: return the validated ordered fallback names as launch evidence.

This slice must not pretend terminal transcript scraping is a structured result.

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

- creates only owned no-focus panes (same-tab right split or new tab);
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

- [ ] A valid bundled/user/project profile resolves deterministically with source and shadow evidence.
- [ ] Invalid unrelated profiles do not block valid profiles; invalid reachable fallback graphs fail before launch.
- [ ] Exact profile inspection is bounded and redacts sensitive runtime values.
- [ ] Pi and Claude adapters produce typed, shell-free argv with appended-system-prompt semantics.
- [ ] Profile-backed launch works in a disposable Herdr session and preserves the v1 assignment envelope.
- [ ] At least one bundled Luna profile is used to perform real repository work after deployment.
- [ ] Unit, typecheck, lint, build, and integration gates are green.

## Open questions deferred beyond Slice 1

- Exact Herdr core event/result schema and persistence database format.
- Exact Pi/Claude integration hooks needed to classify provider failures without text heuristics.
- Direct summarizer JSON schema and transcript compaction algorithm.
- Terminal retained-result eviction implementation details.
