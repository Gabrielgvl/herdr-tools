# Spec: Profile-backed Herdr delegation

## Objective

Replace the normal `pi-subagents` delegation path with visible, pane-backed Pi, Claude, and AGY agents launched from reusable profiles. Build it in working layers rather than coupling the first release to every lifecycle feature.

The first implementation slice delivers a strict profile catalog and profile-backed launch that can be dogfooded immediately. It also gives each bundled role an explicit capability policy and one shared role skill across Pi and Claude, with `manager-pi` as the generic advisory manager and `manager-claude` as the explicit Claude/Fable manager and succession profile. Later slices add Herdr-native turn results, same-pane replacement, durable run state, and the blocking `herdr_delegate` lifecycle tool. `pi-subagents` remains installed only until the acceptance gates for the complete replacement pass.

## Validated product decisions

- Profiles are owned and resolved by `herdr-tools`, not the Herdr runtime.
- Bundled profiles use deliberate role-scoped capabilities. Both managers may write only exact assignment-supplied handoff or coordination paths, and neither gains implementation authority. Scout, planner, reviewer, and researcher do not mutate deliverable state; worker owns implementation; the trusted promoter profile may commit and execute the gated delivery workflow for the exact reviewed manifest without changing deliverable content.
- Profiles are separate Markdown files discovered from:
  1. bundled `herdr-profiles/*.md`;
  2. user `~/.pi/agent/herdr-profiles/*.md`;
  3. nearest project `.pi/herdr-profiles/*.md`.
- Exact-name precedence is project > user > bundled; the winning file replaces the whole lower-precedence profile. `promoter-devin`, `promoter-claude`, and `promoter-pi` are reserved delivery-authority names and always resolve from the bundled catalog; user or project candidates cannot replace or block them.
- Files use strict YAML 1.2 frontmatter and a required literal Markdown body. No interpolation, includes, inheritance, environment expansion, or raw argv.
- Filename stem must equal a required lowercase kebab-case `name`; `description`, exact `model`, `kind`, and kind-specific reasoning are required.
- Each profile pins exactly one kind (`pi`, `claude`, `agy`, or `devin`) through a discriminated runtime block. Pi and Claude bodies are appended through their existing system-prompt channels. AGY and Devin bodies are catalog metadata only and never reach the runtime.
- Every bundled profile sets `sessionPersistence: true` so a Herdr/server restart does not intentionally discard the agent session. The parser still supports non-persistent custom Pi profiles, which receive `--no-session`; Claude, AGY, and Devin profiles must always persist.
- Relative runtime-resource paths resolve from the profile scope root. Arbitrary environment overrides are not supported by profile delegation. Containment is validated both lexically at parse time and physically through `realpath` at launch preflight, so a symlinked resource directory cannot satisfy the lexical check while pointing outside the scope.
- Resource selection is owned by the profile alone. `runtime.extensions`, `runtime.skills`, and `runtime.pluginDirs` are not launch-overrideable because an override could otherwise bypass role scoping. Model, thinking, effort, tools, permission mode, and add-directory overrides keep their existing semantics.
- A profile may select a canonical skill that lives outside its own scope root only through a **generated skill bundle**: a whole-tree copy materialized inside the profile scope and pinned by a deterministic SHA-256 tree hash (relative path, executable bit, exact bytes, UTF-8 byte path order; no mtime, daemon, watcher, or cache database). The trust-tier registry is `<scope root>/herdr-skill-bundles.json`, shaped `{approvedSourceRoots?, bundles}`. Generated content is disposable like `dist/`: never authoritative, never hand-edited, reproducible from one canonical source. There is no hand-maintained vendor copy of any canonical skill inside the package.
- **The external-source trust boundary is exactly this.** A `project`-scope registry can never name an absolute source; every project bundle source must be relative and inside the project scope root. The `bundled` and `user` registries may name an absolute canonical source, but only one that is strictly inside a root the *same* registry declares in `approvedSourceRoots` — checked lexically when the registry loads and again physically, after `realpath`, before any digest or copy. An arbitrary absolute path, a filesystem root as an approved root, a relative approved root, or a source equal to an approved root is refused. The bundled scope root is the installed package directory derived from the running module's own location, not from cwd, so no project can present itself as the bundled tier. What this does **not** protect against: whoever can edit the committed registry can widen `approvedSourceRoots`; the gate there is code review of a tracked file, not the runtime.
- A declared canonical source may itself be a symlink, because the owner's canonical trees are reached through symlink farms. The declared path is resolved to its physical directory before hashing and copying, and that **resolved** directory is what must satisfy the approved source set (or, for a relative source, the scope root). A repointed symlink is therefore an escape (`PROFILE_SKILL_SOURCE_NOT_APPROVED`), never a silent redirect. Generated outputs are ordinary whole-tree copies: plain directories and plain files, no symlinks and no hard links back to the canonical inode.
- Generation runs during `npm run generate:skill-bundles`, `npm run build`, and bundled launch preflight when a canonical source changed. One package-scope exclusive file lock serializes generation across Pi and MCP processes. Each target is staged and replaced before its matching pin is atomically rewritten, so a later bundle failure leaves completed bundles consistent. An interrupted replacement is recoverable only when its bytes equal the old pin or the current canonical tree. **The pin is therefore a derived artifact, not hand-authored policy**: the reviewed policy in the registry is the target/source/approved-root mapping. User and project profiles remain validation-only.
- Launch preflight verifies, for **every reachable fallback profile** and before the first launch effect (recipient, prompt source, supervision reservation, or topology change): physical containment, absence of symlinks and non-regular files in every selected skill tree, no duplicate skill names, generated-copy hash equal to the pin, and current canonical-source hash equal to the same pin. Canonical drift in a bundled profile triggers one serialized refresh and revalidation. An edited generated copy, user or project drift, an unsafe tree, or an invalid trust boundary still fails closed as `PROFILE_SKILL_BUNDLE_STALE`, `PROFILE_SKILL_PATH_ESCAPES_SCOPE`, `PROFILE_SKILL_TREE_UNSAFE`, `PROFILE_SKILL_SOURCE_NOT_APPROVED`, or `PROFILE_SKILL_BUNDLE_REGISTRY_INVALID`. An unexpected IO error is re-raised as itself rather than relabeled as a skill-selection verdict.
- **The same validation runs a second time per attempt, immediately before that attempt's argv is built.** Preflight is separated from `agent start` by recipient creation, prompt-source writes, context resolution, supervision reservation, and topology mutation — seconds and several CLI round-trips in which a swapped skill tree or repointed symlink would otherwise reach the agent unchecked. The second pass narrows that window to the gap between the last digest read and the child's own `open()`. It does not close it, and no design here can: the installed CLI accepts resource *paths*, not inherited open handles, so a check-then-spawn gap is structural. The residual is accepted as bounded, not as safe-by-construction — winning the remaining race needs write access to the profile scope root or to a canonical source tree, and anyone holding that access can already edit the package's own code, its registry, or the canonical trees outright, so the race grants no capability they lack. Because this pass runs after the first effect, its failure is reported as `LAUNCH_FAILED` carrying the skill-selection verdict in `causeCode`, and the launch is torn down through the ordinary failure path.
- Generated bundles stay committed and installed so a fresh checkout can launch before any build. Because launch also re-hashes the live canonical source, **profile-backed launch requires the owner's canonical skill trees present at their registered absolute paths**: on a machine without them, launch fails closed rather than silently running an unverified copy. The registry consequently pins owner-machine absolute paths and the package is not portable as-is; that is accepted over half-portable `~`-relative paths, which would imply portability that the courier workspace paths do not have.
- Pi and Claude profile bodies are stored as durable owner-only prompt sources before topology mutation. The source is a UTF-8 exact-body SHA-256 content-addressed file under the Herdr-tools cache directory (`0700` directory, `0600` file), reused across launches and restarts; successful sources are never deleted.
- Typed call overrides may replace typed defaults, including capability-expanding Claude permission modes. Reserved promoter profiles reject all runtime overrides so their model and capability policy remain trusted. Project profiles have no trust gate except that the three reserved promoter names cannot replace bundled profiles. These are deliberate trust choices.
- Fallbacks are ordered references to named profiles, validated as a graph. A launch has at most four attempts. Invalid profiles are isolated; only the selected reachable graph blocks launch.
- Automatic fallback is allowed only after the installed CLI failure envelope `{id:"cli:agent:start",error:{code:"agent_start_failed",message:"agent process exited before becoming interactive"}}` with non-killed exit 1 and untruncated stderr, followed by an authoritative pane read with `agent_status:"unknown"` and no agent identity/session fields. Timeout, malformed protocol, identity, kind, prompt, provisional supervision, strengthening, and uncertain-state failures stop. After any possible prompt effect, launch never retries, falls back, cleans up, or releases the recovery handle.
- Fallback targets use their own untouched defaults. Typed overrides apply only to the requested primary. The logical cwd, task, placement, and provenance carry across attempts.
- Bundled roles are `manager`, `scout`, `planner`, `worker`, `reviewer`, `researcher`, and `promoter`. `manager-pi` uses `openai-codex/gpt-6-astra` with xhigh thinking as the generic advisory profile. Pi thinking is profile-specific. Claude effort, AGY mode, and the recurring supervisor reviewer's thinking are unaffected. `manager-claude` uses the rolling `fable` alias with high effort, default permission mode, persistent session state, and the manager plugin; the manager chain is `manager-claude -> manager-pi -> manager-devin`. The other role directions and models are:
  - scout: `gemini-3.8-flash-low` -> `claude-sonnet-5` -> `swe-2-max` -> `openai-codex/gpt-5.6-luna`;
  - researcher: `gemini-3.8-flash-low` -> `claude-sonnet-5` -> `swe-2-max` -> `openai-codex/gpt-5.6-luna`;
  - worker: `swe-2-max` -> `openai-codex/gpt-5.6-luna` with max thinking -> `claude-opus-5`;
  - reviewer: `swe-2-max` -> `openai-codex/gpt-5.6-sol` -> `claude-opus-5`;
  - planner: `openai-codex/gpt-6-astra` with xhigh thinking -> `claude-fable-5` -> `swe-2-max`;
  - promoter: `swe-2-max` -> `claude-opus-5` -> `openai-codex/gpt-5.6-luna`.
  AGY research uses fixed plan mode and permission bypass. `worker-agy` (`gemini-3.8-flash-high`, fixed `accept-edits`) is no longer on the default implementation chain and remains directly selectable with `worker-agy -> worker-claude`.
- Every bundled Pi and Claude profile has one role-scoped skill; `manager-pi` additionally loads the cross-role `harness-flow` skill. Claude profiles load the corresponding scope-local plugin directory; Pi profiles load the same skill path directly. Manager, planner, researcher, and promoter also load the canonical Executor skill and allowlist its tools; Pi uses the global `pi-mcp-adapter`, while Claude loads the profile-scoped Executor plugin. Scout, worker, reviewer, and every AGY profile do not expose Executor tools. Each role additionally carries the owner-approved generated skill bundles for its role plugin, plus, for the Pi lanes that hold the tools those skills need, the `context-mode` and `tmux-background-tasks` bundles under `herdr-profiles/pi-skills` — kept outside every plugin directory so no Claude role receives them. A profile never selects a skill whose required tools its allowlist withholds, and the tool allowlist is never widened to justify a skill. Normal installed extension discovery remains enabled, while profile allowlists omit hidden delegation, durable-memory mutation, and unapproved lifecycle capabilities.
- **The manager role plugin is the globally installed package, so profile extras never enter it.** `herdr-profiles/role-plugins/manager` is the plugin published as `herdr-tools` through `.claude-plugin/marketplace.json`; anything added there lands in every ordinary Claude session's skill and tool namespace. It therefore stays at exactly four files — manifest, `mcp-servers.json`, `skills/harness-flow`, `skills/manager` — and it alone owns the `herdr` stdio server and the `mcp__plugin_herdr-tools_herdr__*` tool names. The manager profile's selected extras live in a distinct **session-only generated plugin**, `herdr-profiles/profile-plugins/manager`, named `herdr-manager-profile` with no server map: a tracked manifest plus generated `skills/` holding the manager matrix (`manager`, `harness-flow`, and the six approved extras) as ordinary files. `manager-claude` loads that plugin plus the profile-scoped Executor plugin; `manager-pi` reads the same generated extras but keeps its own two skills at their tracked canonical paths, because copying a package-owned skill for Pi buys nothing. The two package-owned skills are consequently registered bundles with in-scope relative sources, pinned like any other, so a drift between the tracked skill and the generated plugin copy fails launch closed. Herdr installs, enables, disables, or mutates no global plugin state to achieve this.
- **Skill isolation is not equivalent across runtimes, and this is deliberate.** All three runtimes stay available as best effort; the guarantee each one actually provides differs and must not be described as parity:
  - **Pi is an exact allowlist.** Every profile-backed Pi launch passes `--no-skills` plus the profile's repeated `--skill` entries, so global, project, and package skill discovery is off and only the selected skills load. An empty `runtime.skills` therefore means exactly no skills. Verified against the installed Pi CLI: the same launch without `--no-skills` exposes the owner's full ambient skill catalog, with it exactly the selected skill.
  - **The Pi `--tools` allowlist also filters extension tools, so it gates the Codex adapter.** Pi builds its tool registry by applying the allowlist to built-in, extension, and custom tools alike, and that filtered registry is the tool inventory extensions read back. The `pi-codex-conversion` Codex adapter deactivates itself and reports `Codex adapter off: unavailable tools (...); check tool allowlist` whenever any tool in its **current runtime plan** is absent from that inventory. That plan is a subset of the adapter's owned names, chosen by the user-selectable adapter mode and config: the normal-mode plan is `exec_command`, `write_stdin`, `apply_patch` plus `view_image` and the context-management tools when enabled, while code and notebook modes plan `exec`, `wait`, and `notebook` instead. No single plan requires all of them. Every bundled Pi profile therefore allowlists the adapter's full owned surface -- `change_reasoning`, `exec_command`, `write_stdin`, `apply_patch`, `exec`, `wait`, `notebook`, `view_image`, `new_context`, `get_context_remaining`, `history`, `notes` -- in the adapter's own order, so that whichever mode the owner selects has its plan satisfiable rather than silently deactivating the adapter. Availability is not activation: the adapter activates only its planned subset, leaves the remaining owned names inactive, and drops native `read`, `bash`, `edit`, and `write` from the active set while it runs, which is its own intentional resolution of the duplicate shell and edit surfaces. All seven bundled Pi profiles use `openai-codex/*` models, so none of these names is ever exposed as a bare extension tool with the adapter off. This widens the allowlist to grant a capability rather than to satisfy a skill: `manager-pi` had no shell tool before and gains `exec_command`/`write_stdin`.
  - **Claude is additive, not isolated.** The profile's generated minimal role plugin is passed as a session-scoped `--plugin-dir`, but it loads *on top of* whatever the viewer's user, project, and managed-policy configuration already provides. Ambient extras are accepted. Herdr has no `--restricted`/exact-`--tools` contract test today, so no exclusivity claim is made. Re-evaluating this needs a version-gated init-time test proving the intended set and no extras.
  - **AGY has no per-session selector at all** and runs with ambient workspace and user skills. Herdr never writes the real project's `.agents` configuration, never toggles installed AGY plugins, never mutates global or project skill/plugin state, and never substitutes a synthetic workspace root, because each of those is shared mutable state or would change project root, native `AGENTS.md` discovery, git/worktree behavior, and the logical cwd that the fallback contract carries across attempts.
  - Consequently, a strict Pi profile that falls back to Claude or AGY loses the exact-allowlist property for that attempt. Fallback chains are preserved as an availability decision, not an isolation guarantee.
- Bundled role bodies are rewritten for Herdr; they do not preserve chain, artifact, fork, or `pi-subagents` implementation assumptions.
- Each qualified Pi, Claude, or Devin run owns one **handoff artifact** at a launcher-generated path in endpoint-private Herdr Tools state. The fixed six-section Markdown record and run marker are validated independently from raw agent status. For authoritatively identified managed runs, `completed` and `terminal` waits remain unmatched until the current artifact validates; validation occurs before target aggregation. AGY remains unqualified. Turn-level cancellation does not end a run, and runtime-authored fallback requires confirmed run-level cancellation or authoritative exit. Restart restoration is deferred: shutdown leaves unresolved records `recovery_pending`, with endpoint-lifetime retention and same-UID cooperative trust. No database, daemon, watcher, transcript scraping, caller path, or static profile edit is introduced. See ADR-031.

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

`herdr_launch` has one public mode: `{name, profile, assignment, assignmentDelivery?, overrides?, placement?, label?, cwd?, focus?}`. The `assignment` object is mandatory for every Pi, Claude, AGY, and Devin launch and carries exactly `objective`, `scope`, and `verification`, each a non-empty string without NUL; extras, missing or empty fields, and the removed `initialPrompt`/`initialPromptDelivery` fields are all rejected before any mutation. The three fields render in that fixed order into the existing provenance envelope, and the rendered payload's UTF-8 size is the single authority for the `inline` (default) or `attachment` `assignmentDelivery` bound. Raw `kind`, `argv`, and `env` fields are rejected. Profile discovery remains rooted at the manager session cwd and accepts arbitrary valid named profiles.

The advisory role defaults are: manager-pi for generic management, worker-devin for implementation, planner-pi for planning, scout-agy for reconnaissance, researcher-agy for research, and reviewer-devin for review. The explicit `harness-flow` overrides those generic defaults with `scout-pi`, `researcher-pi`, `planner-pi`, `worker-devin`, `reviewer-devin`, and `promoter-devin`; its promoter chain is `promoter-devin -> promoter-claude -> promoter-pi`. The exact AGY chains are `scout-agy -> scout-claude -> scout-devin -> scout-pi` and `researcher-agy -> researcher-claude -> researcher-devin -> researcher-pi`; the implementation chain is `worker-devin -> worker-pi -> worker-claude` and the review chain is `reviewer-devin -> reviewer-pi -> reviewer-claude`. The planner chain is `planner-pi -> planner-claude -> planner-devin` and the manager chain is `manager-claude -> manager-pi -> manager-devin`. Select manager-claude when the owner requests Claude/Fable management or Claude-to-Claude succession. These defaults do not restrict arbitrary valid profile selection. Primary-only typed overrides never leak into fallback profiles. Profile `timeoutMinutes` is task policy; Herdr startup uses a separate valid 120000 ms readiness timeout and a small CLI execution margin.

AGY accepts only `model` and scope-normalized `addDirs` overrides. Its argv is fixed to `--model <model> --mode <profile.mode> --dangerously-skip-permissions`, with required fixed `mode` exactly `plan` or `accept-edits`; mode is not launch-overrideable. Researcher and scout profiles use `plan`; the worker profile uses `accept-edits`. The declared add directories and the Herdr-Tools-owned recipient attachment directory follow. It accepts no prompt file, raw argv, or arbitrary environment. The mandatory typed `assignment` is visible, provenance-wrapped, and self-contained because the profile body remains metadata and AGY receives repository `AGENTS.md` only through native discovery. The worker's accept-edits mode plus permission bypass can auto-approve mutations, so manager assignments must bound scope and tests.

Devin accepts only `model` and `permissionMode` overrides. Its argv is fixed to `--model <model> --permission-mode <mode>`, with `permissionMode` one of the canonical `normal`, `accept-edits`, `smart`, or `dangerous` values; `autonomous` is not expressible because it requires `--sandbox`, which profiles cannot declare. Devin has no effort flag, prompt-file channel, per-session tool selector, or `--add-dir`; reasoning depth rides on the selected model tier. The profile body is catalog metadata that never reaches Devin, so the mandatory typed `assignment` is again the only instruction channel and must be self-contained and provenance-wrapped. Devin reports its native session through the installed `herdr:devin` hook at session start, so it keeps the strict exact-identity launch contract and never enters AGY's provisional path. `worker-devin` and `reviewer-devin` run `dangerous`, which approves every tool call without prompting, so manager assignments must bound scope and required tests, and reviewer assignments must restate the read-only, no-self-approval contract explicitly.

Launch details include requested and selected profile names, effective runtime, model, source, timeout, permissions, bounded per-attempt evidence, and prompt confirmation evidence. Pi, Claude, and Devin retain complete native-session readiness before dispatch. Every launch delivers its assignment, so every launch requires the idle lifecycle baseline and there is no promptless success path.

AGY alone may publish a running, live, non-cancellable `provisional` supervisor after one coherent idle sample proves pane, terminal, name, kind, sequence, and revision without a native session. It then submits the mandatory envelope exactly once and requires the official full native `agent_session`, lifecycle advancement, and non-regressed revision within the existing five-second confirmation window. One observer-backed transaction drains provisional events before atomically publishing exact `active` or `degraded` coverage. Recipients and attachments remain unavailable until strengthening and semantic assignment confirmation both succeed.

This provisional window carries an AGY-only reduced-assurance risk: pane, terminal, name, and kind continuity is not cryptographic attribution. A same-terminal replacement or stale report can be misattributed until exact strengthening. This AGY runtime support is a Herdr Tools-only change. Herdr Tools bounds but cannot eliminate that risk without a Herdr Core change. Pi, Claude, and Devin remain strict. Any possible prompt effect followed by acknowledgement, transport, identity, read, timeout, or strengthening failure leaves the provisional supervisor and child visible and performs no retry, fallback, cleanup, reservation release, or recipient registration. The only fallback remains the exact pre-interactive no-agent case.

### Slice 2: Herdr runtime prerequisites

Add to Herdr core and managed Pi/Claude integrations:

- stdin prompt transport with a 64 KiB task limit;
- authoritative turn IDs and structured turn-result events;
- structured provider failure classification;
- exact turn cancellation;
- same-pane native `agent replace` preserving scrollback;
- durable logical-run lineage and exact identity reconciliation;
- owner-only local result/transcript storage with unguessable bearer refs;
- run-owned handoff path allocation under Herdr state, normal completion blocked until the artifact validates, a distinct runtime-authored record for forced stop/crash, and artifact evidence surfaced through inspect, wait, and completion.

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
npm run generate:skill-bundles
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
herdr-profiles/profile-plugins/ generated session-only profile plugins (manager)
herdr-profiles/pi-skills/   generated Pi-only bundles, outside every plugin dir
herdr-skill-bundles.json    approved source roots and pinned generated bundles
src/profiles/skill-bundles.ts registry, tree hashing, generation, launch validation
scripts/generate-skill-bundles.ts build-time generation entrypoint
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
  return validateReachableGraph(profile, catalog, 4);
}
```

Reject unknown fields, ambiguity, cycles, malformed paths, oversized files, and incompatible kind fields. Never silently infer legacy values.

## Testing strategy

- Unit-test parsing, schema rejection, precedence, shadow reporting, graph cycles/missing targets/max attempts, path resolution, argument generation, bounds, and redaction.
- Unit-test generated bundles: deterministic digest and idempotent regeneration, canonical drift, generated tamper, missing canonical source, arbitrary external source rejection per trust tier, symlinked canonical source resolved to its physical tree, symlink escape after resolution, ordinary-copy output, duplicate generated targets, and no launch effect before any of those failures. Assert the real package registry resolves against the live canonical trees on both sides of the pin, and that its only in-package sources are the two tracked manager role skills.
- Assert both manager plugin trees exactly: the globally installable package at its four files, and the generated manager profile plugin at its manifest plus the full manager matrix, with a distinct plugin name, no server map, no policy surface, no symlinks, byte-identical copies of the two package-owned skills, and `marketplace.json` still publishing only the minimal package.
- Assert the 24 bundled profiles, the exact role fallback chains and per-profile fixed AGY argv, exact manager-claude and role capability matrices, shared resource paths, no hidden delegation tools, read-only mutation exclusions, and representative Pi, Claude, and AGY launch flags.
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
- Adding an entry to `approvedSourceRoots`, which widens the external canonical source set.

### Never

- Scrape terminal text and label it a structured result.
- Use transcript regexes to classify quota/provider failures.
- Pass raw argv or arbitrary env through profile-backed delegation.
- Auto-close caller-owned/existing panes.
- Add old-profile compatibility or fallback behavior that hides invalid configuration.
- Generate or repin a user or project skill bundle during launch, or trust a generated bundle whose bytes match neither its pin nor its canonical source.

## Slice 1 success criteria

- [ ] Twenty-four bundled profiles resolve deterministically with source and shadow evidence; `manager-pi` remains the generic advisory manager and `manager-claude` is selected for explicit Claude/Fable management or Claude-to-Claude succession; the manager chain is `manager-claude -> manager-pi -> manager-devin`.
- [ ] Every bundled role has one shared role skill, with matching Pi skill and Claude plugin resources; the globally installable manager plugin also carries the cross-role `harness-flow` skill and nothing else, while `manager-claude` loads the manager matrix from the session-only generated manager profile plugin.
- [ ] Pi and Claude capability matrices exclude hidden delegation, keep direct content mutation tools limited to workers, and limit promoter content to the reviewed manifest while allowing its gated delivery workflow.
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
