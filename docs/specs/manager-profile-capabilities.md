# Spec: Manager Profile and Role-Scoped Capabilities

## Status

Implemented and verified.

## Objective

Add bundled `manager-pi` and `manager-claude` profiles that orchestrate visible Herdr workers without unapproved repository changes. Keep `manager-pi` as the generic advisory default and select `manager-claude` for owner-requested Claude/Fable management or Claude-to-Claude succession. Give every bundled Pi and Claude profile a deliberate role-scoped tool policy and a shared role skill, while retaining normal installed extension discovery.

Success means profile launches are useful by default, hidden subagent spawning is excluded, non-manager roles can persist required handoffs without gaining new authority, and missing task-critical extension capabilities are reported as blockers instead of silently replaced by weaker behavior.

## Validated Owner Decisions

- Keep `manager-pi` as the generic advisory default and add `manager-claude` for owner-requested Claude/Fable management or Claude-to-Claude succession.
- Both manager profiles orchestrate visible workers and may use Edit/Write only for an exact assignment-supplied handoff or coordination path. Both managers now hold a shell capability -- Claude through `Bash`, Pi through the Codex adapter's `exec_command`/`write_stdin` -- and both require direct owner approval for shell and control-plane actions. Neither manager may perform unapproved implementation, testing/smoke execution, deployment, merge, publication, or other mutation.
- Use role-scoped tool allowlists while retaining installed extension discovery.
- Configure role-specific skills.
- Advisory defaults are manager-pi for generic management, worker-devin for implementation, planner-claude first with planner-pi fallback for planning, scout-agy for reconnaissance, researcher-agy for research, and reviewer-devin for review. The exact chains are `scout-agy -> scout-claude -> scout-pi`, `researcher-agy -> researcher-claude -> researcher-pi`, `worker-devin -> worker-agy -> worker-claude`, and `reviewer-devin -> reviewer-pi -> reviewer-claude`. Select manager-claude when the owner requests Claude/Fable management or Claude-to-Claude succession. Planner order is intentional and must not be inverted.

## Assumptions

1. `manager-pi` uses `openai-codex/gpt-6-astra` with `thinking: low`, a 30-minute timeout, and persistent Pi session state.
2. `manager-claude` uses the rolling `fable` alias, which Claude Code resolves to the latest supported Fable model, with high effort, default permission mode, a 30-minute timeout, persistent session state, and no fallback because manager identity must not silently change. It declares no development channels, so it emits no `--dangerously-load-development-channels` opt-in and its supervisor wakes are recovered by `herdr_jobs` polling.
3. Existing Claude model and fallback choices remain unchanged. `scout-agy` and `researcher-agy` use `gemini-3.8-flash-low`; `worker-agy` uses `gemini-3.8-flash-high`. AGY modes are fixed as `plan`, `plan`, and `accept-edits` respectively.
4. Pi extension discovery remains enabled. The globally configured `pi-mcp-adapter` provides Executor; manager, planner, researcher, and promoter allowlist its tools and load its skill. Every Pi profile keeps `runtime.extensions` empty to avoid duplicate adapter registration.
5. Tool names from inherited extensions are allowlisted only where they serve the role. If a task requires an allowlisted extension tool that is not installed, the role skill requires a visible blocked result; it must not claim equivalent verification through an unspecified fallback.
6. Claude role skills are packaged as scope-local Claude plugins. The corresponding Pi profile loads the same `SKILL.md` path directly, so role method has one source of truth across runtimes.
7. Non-manager profiles cannot spawn hidden subagents. Pi profiles omit `Agent` and Herdr lifecycle tools; Claude profiles disallow `Task`.
8. Read-only describes repository authority, not tool absence. Non-manager Pi and Claude roles already retain Bash and now also receive edit/write for assignment-required handoffs; their role skills still prohibit unassigned repository mutation. The same now holds for both managers, whose shell capability is bounded by owner approval in the role skill rather than by the absence of a shell tool.
9. AGY support is implemented only in Herdr Tools. It requires no Herdr Core change. The AGY profile body is metadata, not a runtime prompt.

## Tech Stack

- TypeScript profile catalog and typed launch adapters already in `src/profiles/`
- Strict YAML 1.2 Markdown profiles in `herdr-profiles/`
- Pi CLI role resources through `runtime.tools` and `runtime.skills`
- Claude CLI role resources through `allowedTools`, `disallowedTools`, `permissionMode`, and `pluginDirs`
- Vitest unit and integration coverage

## Commands

```bash
npm run test:unit
npm run typecheck
npm run lint
npm run build
HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration
```

## Project Structure

```text
herdr-profiles/
  manager-pi.md
  manager-claude.md
  *-pi.md
  *-claude.md
  researcher-agy.md
  scout-agy.md
  worker-agy.md
  role-plugins/
    manager/
      .claude-plugin/plugin.json
      mcp-servers.json
      skills/manager/SKILL.md
    scout/
      .claude-plugin/plugin.json
      skills/scout/SKILL.md
    planner/
      .claude-plugin/plugin.json
      skills/planner/SKILL.md
    worker/
      .claude-plugin/plugin.json
      skills/worker/SKILL.md
    reviewer/
      .claude-plugin/plugin.json
      skills/reviewer/SKILL.md
    researcher/
      .claude-plugin/plugin.json
      skills/researcher/SKILL.md

src/tools/launch.ts
test/unit/profile-catalog.test.ts
test/unit/launch.test.ts
docs/specs/manager-profile-capabilities.md
docs/decisions/007-role-scoped-profile-capabilities.md
```

From the package scope root, each Pi profile points `runtime.skills` at `herdr-profiles/role-plugins/<role>/skills/<role>`. Each Claude profile points `runtime.pluginDirs` at `herdr-profiles/role-plugins/<role>`.

## Capability Matrix

### Pi profiles

Common extension-backed navigation tools are selected by name but still supplied through normal installed extension discovery:

- Fast navigation: `ffgrep`, `fffind`
- Bounded context processing: `ctx_execute`, `ctx_execute_file`, `ctx_search`
- Web evidence: `web_search`, `source_check`, `fetch_content`, `get_search_content`

| Profile | Active tools |
|---|---|
| `manager-pi` | `read`, `grep`, `find`, `ls`, `edit`, `write`, `ask_user_question`, Executor, and Herdr lifecycle tools, plus the Codex adapter surface | Generic advisory manager; writes only exact assignment-supplied handoff or coordination paths. Owner-approved: the adapter surface gives it `exec_command`/`write_stdin`, so it now has shell execution, and `apply_patch`. |
| `manager-claude` | Core research tools, `Edit`, `Write`, Herdr MCP, and Executor MCP | Claude `default`; only `Task` is disallowed. Writes only exact assignment-supplied handoff or coordination paths. |
| `scout-pi` | `read`, `bash`, `grep`, `find`, `ls`, `ffgrep`, `fffind`, `ctx_execute`, `ctx_execute_file`, `ctx_search`, `edit`, `write` |
| `planner-pi` | Scout set plus `web_search`, `source_check`, `fetch_content`, `get_search_content` |
| `worker-pi` | Planner set plus `bash_bg`, `jobs`, `job_decide`, `monitor` |
| `worker-devin` | Devin runtime with `dangerous` permission mode; no per-session tool or skill selector |
| `reviewer-devin` | Devin runtime with `dangerous` permission mode; read-only reviewer by assignment |
| `reviewer-pi` | Planner set |
| `researcher-pi` | Planner set |
| `promoter-pi` | `read`, `bash`, `grep`, `find`, `ls`, `ctx_execute`, `ctx_execute_file`, `ctx_search`, `edit`, `write`; exact reviewed commit and gated delivery scope only |

Every Pi row above additionally allowlists the full 12-tool Codex adapter surface --
`change_reasoning`, `exec_command`, `write_stdin`, `apply_patch`, `exec`, `wait`,
`notebook`, `view_image`, `new_context`, `get_context_remaining`, `history`, `notes` --
because Pi applies `--tools` to extension tools as well as built-ins and the adapter
deactivates itself when any tool in its current runtime plan is missing. The adapter
activates only its planned subset and drops native `read`, `bash`, `edit`, and `write`
while it runs. For `manager-pi` this is an owner-accepted capability change rather than
a neutral one: the profile previously had no shell tool at all and now receives
`exec_command`/`write_stdin`. **Owner approval and the manager's lack of implementation
authority are therefore policy constraints in the role skill, not the mechanical
absence of a shell tool.**

Explicitly absent from every non-manager Pi profile:

- `Agent` and `agent_bg`
- Herdr lifecycle tools
- durable-memory mutation tools

Every Pi and Claude profile receives edit/write so it can persist an assignment-required handoff. Manager profiles restrict writes to exact assignment-supplied handoff or coordination paths and do not gain implementation authority. Manager, planner, researcher, and promoter load the Executor skill and allowlist its tools; Pi uses the global adapter while Claude loads the profile-scoped plugin. Scout, worker, reviewer, and every AGY profile do not expose Executor tools. Executor availability itself never authorizes an external mutation; the trusted promoter profile authorizes only its standard gated delivery workflow for the exact reviewed manifest and targets.

### AGY role profiles

`scout-agy` and `researcher-agy` use `gemini-3.8-flash-low`, persistent sessions, fixed `plan` mode, and `--dangerously-skip-permissions`; `worker-agy` uses `gemini-3.8-flash-high` with the same bypass and fixed `accept-edits` mode. Only model and scope-normalized `addDirs` may be overridden; mode is fixed per profile. AGY profile bodies are catalog metadata. Every launch requires one visible, provenance-wrapped, self-contained typed `assignment` of exactly `objective`, `scope`, and `verification`; AGY discovers repository `AGENTS.md` natively. Because worker accept-edits plus the bypass can auto-approve mutations, manager assignments must bound scope and required tests.

AGY initially publishes provisional pane, terminal, name, and kind supervision because its native session may appear only after the first prompt. The launch strengthens to exact native-session supervision before reporting success or registering recipient and attachment capability. A failure after possible prompt effect leaves the provisional child and recovery evidence visible, with no retry, fallback, cleanup, reservation release, or recipient registration. This reduced-assurance window is accepted for AGY only. Pi, Claude, and Devin still require complete native-session identity before assignment.

### Devin role profiles

`worker-devin` is the implementation default. It launches Devin with `--model swe-2-max --permission-mode dangerous` and falls back to `worker-agy`, yielding exactly `worker-devin -> worker-agy -> worker-claude`; `worker-pi` remains selectable when the owner requests the Pi runtime explicitly. `reviewer-devin` is the review default with the same Devin runtime and `reviewer-devin -> reviewer-pi -> reviewer-claude`; its assignment and profile body are explicitly read-only, and it never approves or promotes its own work. Reasoning depth rides on the selected model tier because the Devin CLI exposes no effort flag, and sessions always persist. Only `model` and `permissionMode` may be overridden; `permissionMode` accepts the canonical `normal`, `accept-edits`, `smart`, and `dangerous` values (`autonomous` is not expressible because it requires `--sandbox`). Devin profile bodies are catalog metadata, so every launch requires the same visible, provenance-wrapped, self-contained typed `assignment` as AGY. `dangerous` auto-approves every tool call, so manager assignments must bound scope and required tests. Devin reports its native session through the installed `herdr:devin` hook at session start, so it binds under the strict exact-identity path rather than AGY's provisional one.

### Claude profiles

| Role | Permission mode | Pre-approved tools | Disallowed tools |
|---|---|---|---|
| Scout | `dontAsk` | `Read`, `Glob`, `Grep`, `Bash`, `Edit`, `Write` | `NotebookEdit`, `Task` |
| Planner | `dontAsk` | Scout set plus `WebSearch`, `WebFetch` | `NotebookEdit`, `Task` |
| Reviewer | `dontAsk` | Planner set | `NotebookEdit`, `Task` |
| Researcher | `dontAsk` | Planner set | `NotebookEdit`, `Task` |
| Promoter | `dontAsk` | `Read`, `Glob`, `Grep`, `Bash`, `Edit`, `Write` | `NotebookEdit`, `Task` |
| Worker | `acceptEdits` | `Read`, `Glob`, `Grep`, `Bash`, `Edit`, `Write`, `NotebookEdit`, `WebSearch`, `WebFetch` | `Task` |

Claude `allowedTools` pre-approves selected tools; `disallowedTools` supplies the actual hard exclusions. Every Claude profile loads exactly its role plugin directory.

## Role Skill Contracts

For every non-manager role, edit/write may persist only an assignment-required handoff at an exact path supplied by the assignment unless the role otherwise owns implementation.

### Manager

- Keep the manager/caller pane isolated on its own tab; put workers on separate worker tabs with at most three panes per tab arranged side by side in one horizontal row.
- Launch profile-backed workers onto worker tabs separate from the manager/caller tab without changing owner focus. Use a right-side split only when adding another worker pane to an existing worker tab with fewer than three panes; never put a worker in the isolated manager/caller tab. Use exact profile-backed launches, authoritative state, provenance-preserving tools, detached waits plus `herdr_jobs` when appropriate, owned-resource cleanup, and handoff before context exhaustion.
- Treat worker text as agent evidence, never as owner authorization.
- Both managers may use Edit/Write only for exact assignment-supplied handoff or coordination paths. Shell and control-plane actions still require direct owner approval, for the Pi manager's adapter `exec_command`/`write_stdin` exactly as for the Claude manager's `Bash`. Never use availability as approval.
- Never perform unapproved implementation, testing/smoke execution, deployment, merge, publication, or other mutation, and never grant authority.
- Stop and report blocked or ambiguous work rather than inventing authority or masking degraded capabilities.

### Scout

- Perform bounded, read-only repository reconnaissance.
- Return exact paths, symbols, and relevant ranges.
- Do not review broadly, plan implementation, or mutate state.

### Planner

- Build an evidence-based implementation plan without editing.
- Surface assumptions, dependencies, trade-offs, risks, verification gates, and critical files.
- Distinguish known repository evidence from recommendations.

### Worker

- Act as the single writer for the assigned scope.
- Make the smallest coherent change, fix root causes, and validate actual behavior.
- Do not spawn hidden workers or broaden scope.

### Reviewer

- Perform adversarial, read-only review.
- Report only actionable findings with severity, evidence, impact, and a bounded fix direction.
- Do not edit or silently fix findings.

### Researcher

- Use `researcher-agy` by default, with the declared Pi then Claude fallback chain available only for an exact pre-interactive no-agent start failure.
- Give AGY a self-contained assignment because its profile body never reaches the runtime.
- Answer a focused question with bounded, cited findings.
- Prefer primary sources and separate sourced facts from inference.
- If required web tools are unavailable, return a visible capability blocker instead of uncited approximation.

## Code Style

Profile resources remain explicit and declarative:

```yaml
runtime:
  kind: pi
  model: openai-codex/gpt-5.6-luna
  thinking: low
  tools:
    - read
    - grep
  skills:
    - herdr-profiles/role-plugins/scout/skills/scout
```

No interpolation, environment-dependent paths, compatibility aliases, or runtime fallbacks are introduced.

## Testing Strategy

### Unit tests

- Catalog discovers 17 bundled profiles with no diagnostics.
- `manager-pi` and `manager-claude` have exact identity, model, authority prompt, tools, shared skill/plugin path, and empty fallbacks.
- Every Pi profile has a non-empty role allowlist and a scoped role skill; `manager-pi` additionally loads `harness-flow`.
- Every Claude profile has explicit permission mode, allowed/disallowed tools, and its scoped role plugin. Executor-enabled roles also load the separate Executor plugin.
- Every Pi and Claude profile includes edit/write for assignment-required handoffs; role contracts still prohibit unassigned repository mutation.
- Non-manager roles exclude hidden delegation tools.
- Pi and Claude launch argv contain the exact tool, skill, permission, and plugin flags. AGY argv contains the exact model, plan mode, permission bypass, and bounded add-directory flags with no prompt source.
- Invalid or escaping role resource paths remain rejected by existing parser tests.
- A profile launch accepts that real Herdr protocol 22 `agent_started` may omit identity fields, then runs one bounded, read-only identity-readiness preflight (target approximately five seconds with short polling) before any prompt dispatch or recipient registration. Each sample freshly reads snapshot, `agent get`, and pane and joins only that coherent sample with fields actually supplied by start; missing components are never merged across samples. A complete start field may cover a fresh omission, but a missing start session must arrive in one sample. Contradictions fail immediately; timeout or caller abort fails closed with bounded evidence. Only the exact captured pane/terminal/name/kind and complete `agent_session` identity permits one provenance-wrapped `agent prompt --stdin` submission without `--wait`; the readiness window is not a prompt retry. The exact captured identity plus `agent_prompted` and `interactive_ready:true` acknowledge acceptance. The same full identity is persisted for attachment recipients; optional `agent_id` is diagnostic only. Headless `screen_detection_skipped`, idle post-state, stale revision, or unavailable/replaced observation never triggers Enter, a runtime hook, fallback, or a duplicate submission, and a replacement is never returned as authoritative post-state.

### Integration

- Profile inspection reports the new manager and role resources without diagnostics.
- A disposable profile launch proves selected resources reach the child CLI.
- Existing provenance, topology, and profile launch gates remain green.

## Implementation Plan

### 1. Add shared role resources

- Add seven scope-local role plugin directories under `herdr-profiles/role-plugins/`.
- Give each plugin a minimal Claude manifest and one `skills/<role>/SKILL.md` contract.
- Keep role method in the shared skill; keep profile bodies focused on identity, authority, and expected result shape.
- Add `herdr-profiles/manager-pi.md` with the approved Sol/high orchestration-only configuration and no fallback, plus `herdr-profiles/manager-claude.md` with the exact owner-gated Fable manager policy and no fallback.

Checkpoint: load the catalog and build argv for the manager plus one Pi/Claude pair before changing every profile.

### 2. Apply role capability configuration

- Add exact `runtime.tools`, selected `runtime.extensions`, and explicit `runtime.skills` entries to every Pi profile.
- Add exact `permissionMode`, `allowedTools`, `disallowedTools`, and explicit `pluginDirs` entries to every Claude profile.
- Keep models, reasoning, timeouts, persistence, and existing fallback direction unchanged.
- Include `herdr_tab` in the manager set and the four approved background-job tools in `worker-pi`.

Checkpoint: catalog resolution has 19 effective profiles, no diagnostics, and every scoped resource resolves under the bundled profile root.

### 3. Enforce contracts in tests

- Extend `test/unit/profile-catalog.test.ts` with an exact capability matrix and role-resource existence checks.
- Add representative `buildProfileArgv` assertions for manager, worker, read-only Pi, and Claude profiles.
- Update `test/integration/herdr-tools.integration.test.ts` to inspect 19 profiles, inspect manager/promoter profiles plus the AGY role profiles, and verify exact worker and AGY launch arguments without changing provenance or topology assertions.
- Add identity-bound prompt acknowledgement and optional post-dispatch observation in `src/tools/launch.ts`: accept partial Herdr protocol 22 `agent_started` identity, then run one bounded read-only snapshot + `agent get` + pane preflight sample at a time before submission. Join each sample only with start-supplied fields; never merge missing components across samples, and fail immediately on supplied contradictions. After one sample yields the exact pane/terminal/name/kind and complete `agent_session`, submit exactly once through `agent prompt --stdin` and require the typed `agent_prompted` response to match that captured identity, `interactive_ready:true`, and safe revision. Abort/timeout stops before stdin and recipient registration with bounded evidence. Persist that identity for attachments, report working/skipped/stale/unavailable observation without waiting, retrying, runtime hooks, fallback, or sending Enter, and omit replacement post-state from authoritative details and success rows.
- Cover accepted idle/screen-detection-skipped launches, stale/unavailable observation, malformed/mismatched acknowledgements, and the no-duplicate/no-key boundary in `test/unit/launch.test.ts`.
- Do not weaken strict parser, inspection-budget, discovery, or fallback tests.

Checkpoint: unit tests and typecheck pass before documentation finalization.

### 4. Record the architecture change

- Update `docs/specs/profile-backed-delegation.md` so the living product specification includes the manager role and role-scoped resources.
- Add `docs/decisions/007-role-scoped-profile-capabilities.md`, superseding only ADR-006’s five-role/no-resource-default portion while preserving its catalog and delegation architecture.
- Record why normal extension discovery remains enabled, why Claude has no manager profile, and why hidden delegation is excluded.

Checkpoint: lint and build pass with a clean diff limited to profiles, role resources, tests, and documentation.

### 5. Final verification

Run, in order:

```bash
npm run test:unit
npm run typecheck
npm run lint
npm run build
HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration
```

Then inspect the live profile collection from the built extension and confirm:

- 17 effective profiles;
- no diagnostics;
- `manager-pi` reports the exact approved tools and skill;
- existing profiles report their role-specific resources.

## Implementation Tasks

- [x] Add role plugins and shared role skills.
  - Acceptance: seven valid plugin manifests and seven non-empty role skills exist under the bundled scope; the manager plugin also contains `harness-flow`.
  - Verify: profile parser resolves each referenced path without diagnostics.
  - Files: `herdr-profiles/role-plugins/**`.

- [x] Add `manager-pi` and `manager-claude`, and configure all manager/profile capabilities.
  - Acceptance: seven Pi profiles have exact tools and one role skill, with the manager also loading `harness-flow`; manager-claude has the exact owner-gated Claude policy and shared manager plugin; only manager Pi has Herdr lifecycle tools in its Pi allowlist; every non-manager Pi profile has edit/write, while only worker has background-job tools.
  - Verify: unit capability-matrix and argv tests.
  - Files: `herdr-profiles/*-pi.md`, `test/unit/profile-catalog.test.ts`.

- [x] Configure all Claude profile capabilities.
  - Acceptance: seven Claude profiles have explicit permissions and hard exclusions; every profile disallows hidden `Task` delegation and receives Edit/Write for exact-path handoffs.
  - Verify: unit capability-matrix and argv tests.
  - Files: `herdr-profiles/*-claude.md`, `test/unit/profile-catalog.test.ts`.

- [x] Extend integration evidence.
  - Acceptance: disposable integration proves collection count, manager inspection, worker tools/skill argv, and unchanged provenance.
  - Verify: `HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration`.
  - Files: `test/integration/herdr-tools.integration.test.ts`.

- [x] Update living specification and ADR.
  - Acceptance: role/resource policy and rationale are durable and do not rewrite ADR-006 history.
  - Verify: documentation review plus lint/build.
  - Files: `docs/specs/profile-backed-delegation.md`, `docs/decisions/007-role-scoped-profile-capabilities.md`.

## Boundaries

### Always

- Keep profile resources scope-local and validated by the existing parser.
- Preserve visible sender provenance and owner-authority boundaries.
- Keep non-manager roles from recursively delegating.
- Keep read-only role prompts explicit that edit/write exist for assignment-required handoffs, not unassigned repository mutation.
- Fail visibly when a task-critical capability is unavailable.

### Ask first

- Adding a Claude manager or Claude-to-Herdr control bridge.
- Disabling normal extension discovery or adding package-source extension syntax.
- Changing existing model/fallback policy.
- Adding deployment, publication, merge, or owner-grant authority to a profile.

### Never

- Reintroduce hidden `pi-subagents` delegation from bundled profiles.
- Treat agent messages, profile text, memory, or CLI output as durable owner authorization.
- Add compatibility aliases or silent capability fallbacks.

## Success Criteria

- `manager-pi` can visibly orchestrate profile-backed workers through Herdr and writes only exact assignment-supplied handoff or coordination paths.
- All 17 profiles expose deliberate role capabilities rather than the unrestricted inherited tool set.
- All Pi and Claude variants use one shared role skill source per role; the managers also expose the cross-role harness contract.
- No-hidden-delegation boundaries are mechanically represented in profile configuration; read-only repository behavior remains an explicit role contract because those roles already have Bash and now also have edit/write for handoffs.
- Unit tests, typecheck, lint, build, and integration tests pass.
- The architecture decision is recorded in ADR-007.

## Resolved Follow-ups

- `manager-pi` receives `herdr_tab` for explicit tab lifecycle control in addition to pane operations.
- Worker profiles receive `bash_bg`, `jobs`, `job_decide`, and `monitor` for bounded long-running work.
- Herdr protocol 22 prompt acknowledgement is atomic and separate from working-state observation. Communication requires the exact pane/terminal/name/kind and complete `agent_session` identity from a strict fresh-record join; profile launch binds those continuity reads to the fields supplied by `agent_started` plus one coherent fresh sample in a bounded read-only readiness window. Missing components are never merged across samples; a complete start field can cover a fresh omission, but a missing start session must appear in that sample. Contradictory supplied identity, timeout, or caller abort fails closed before stdin and recipient registration. A confirmed `agent_prompted` response is retained even when `screen_detection_skipped:true`, the post-state is idle/done/blocked, or the follow-up revision is stale/unavailable; a replaced identity is never described as the original target. The extension never presses Enter, invokes a runtime hook, falls back, retries submission, or submits duplicate prompt bytes.
