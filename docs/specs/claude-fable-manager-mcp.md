# Spec: Claude Fable manager MCP adapter

## Status

Approved contract; implementation not started.

## Objective

Let an interactive Claude Fable session act as the primary Herdr manager by exposing the existing seven safe `herdr-tools` tools through a local stdio MCP adapter.

The manager is a normal interactive Claude session in a Herdr pane, not a native `.claude/agents` subagent and not a delegated worker profile. One shared tool implementation, profile resolver, and catalog serve both the Pi extension host and the MCP host. Success means a Claude Fable session can inspect, communicate, wait, poll jobs, launch profile-backed workers, and arrange owned panes and tabs with exactly the same policy, evidence, and failure behavior the Pi manager already has, with no second authority and no duplicated schemas.

## Validated owner decisions

- Claude Fable is the primary interactive manager session. No `manager-claude` launch profile and no native subagent profile are added.
- The adapter exposes exactly `herdr_inspect`, `herdr_communicate`, `herdr_wait`, `herdr_jobs`, `herdr_launch`, `herdr_pane`, and `herdr_tab`, in that order, and no other tool.
- Pi and Claude hosts execute one shared tool implementation and one shared profile resolver/catalog. Policy, schemas, bounds, and provenance exist once.
- `@modelcontextprotocol/sdk` is the only planned new runtime dependency.
- Fail-closed health/context gating, in-memory ownership, exact targeting, bounded results, durable prompt sources, and mandatory v1 sender provenance are preserved unchanged.
- Claude detached waits are polled through `herdr_jobs`. The adapter performs no self-communication and no automatic turn injection.
- Profile discovery behavior is unchanged for this slice. The MCP runtime uses the manager session's authoritative project directory, never a plugin installation directory and never a directory derived from the module path.
- The Claude package is packaging plus a manager-conduct skill. The skill cannot claim owner authority and cannot silently grant permissions.
- Primary model selection stays a launch/user configuration concern: the manager is started with `--model claude-fable-5` or switched with `/model fable`. The skill reports a mismatch and stops; it never claims enforcement.
- Unit coverage stays at 100% for the coverage-included sources. Integration uses only the disposable named session `herdr-tools-integration` and never the live workspace.

This slice is the Claude-to-Herdr control bridge that `docs/specs/manager-profile-capabilities.md` lists under "Ask first". The owner has authorized it for the primary interactive manager session only; the ask-first gate remains in force for any Claude worker profile with Herdr lifecycle tools.

## Reconciliation with existing decisions

- ADR-001 stays authoritative: `HERDR_ENV=1` gating, installed-CLI-only Herdr access, memory-only ownership, per-runtime session scope, and fail-closed compatibility. The MCP process is a second *host* for the same narrow runtime, not a second authority.
- ADR-006 and ADR-008 stay authoritative for profiles: `herdr-tools` owns the catalog, launch is profile-only with typed overrides and bounded fallback, and prompt sources are prepared before topology mutation. The adapter adds no launch input and removes none.
- ADR-005 stays authoritative: every prompt, steer, and assignment keeps the mandatory `[HERDR AGENT MESSAGE v1]` envelope with a sender resolved from the authoritative snapshot.
- ADR-007 (role-scoped capabilities) rejected a `manager-claude` profile because no Claude profile had Herdr tool parity. That reasoning is unchanged for *launch profiles*: parity is granted here to the owner-started interactive session, not to a delegated Claude worker.
- ADR-002 stays authoritative for detached waits. The MCP host keeps the in-memory job registry and drops only the Pi-specific notification and TUI surfaces.

## Assumptions

1. The manager Claude session runs inside a Herdr pane, so `HERDR_ENV`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and `HERDR_PANE_ID` are inherited by the MCP subprocess.
2. Claude Code loads a local package through `--plugin-dir`, reads `.claude-plugin/plugin.json`, and resolves its `mcpServers` field to a sibling `mcp-servers.json` server map. `${CLAUDE_PLUGIN_ROOT}` expands to the package root inside that map.
3. Subprocess working directory is never trusted. `CLAUDE_PROJECT_DIR` must be present, absolute, and an existing directory; it is the profile-discovery `projectCwd` and the operational `cwd` for launch/pane/tab. There is no fallback.
4. Claude Code delivers `CLAUDE_PROJECT_DIR` to the MCP server environment, directly or through an explicit expansion entry in the server map. Phase 1 records which form actually works; the server never substitutes another value.
5. `typebox` schemas are JSON Schema documents and can be published as MCP `inputSchema` after a structural adaptation for union roots. The adapter validates arguments with `typebox/value` before invoking a tool, which is exactly the guarantee the Pi host provides today.
6. The shared tool modules can be imported in a plain Node process. They already import `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` for `truncateTail` and the compact renderers.
7. MCP client tool timeouts and the primary model are launch/user configuration. The adapter does not read, set, or claim to enforce either.
8. `config.json` stays the single shared settings file at `/home/gabriel/.pi/agent/extensions/herdr-tools/config.json` with its existing 1..30 minute `wait.reviewCadenceMinutes` and reviewer model fields.
9. Model-backed wait review is a Pi host capability. The MCP host has no model registry, so a wait longer than the effective review cadence fails closed instead of running unsupervised.

## Architecture

### Hosts and shared core

```text
Pi extension host                     MCP host
index.ts                              mcp-server.ts -> src/mcp/run.ts
  pi.registerTool(...)                  Server(list_tools/call_tool) + StdioServerTransport
  ExtensionContext                      src/mcp/host.ts (gating, cwd, capability proxy)
  WaitJobsUi + sendMessage              herdr_jobs polling only
            \                        /
             src/tool-surface.ts (the seven ToolDefinitions)
             src/tools/*.ts  src/profiles/*  src/cli.ts  src/health.ts
             src/ownership.ts src/job-registry.ts src/provenance.ts src/settings.ts
```

`src/tool-surface.ts` becomes the one place that constructs the seven tools from typed dependencies. `index.ts` keeps its Pi-only concerns (command registration, session events, wait-job UI, terminal notifications) and consumes the same surface. `CORE_TOOL_NAMES` moves to `src/tool-surface.ts` and is re-exported from `index.ts` so existing imports and tests keep working.

### Typed adapter boundary

The shared tools read exactly three fields from the host context: `cwd` (launch, pane, tab), `signal` (communicate, pane, tab fallback), and `modelRegistry` (wait reviewer only). The MCP host supplies that narrow object and denies everything else at runtime.

```ts
// src/mcp/host.ts
export const HOST_FIELDS = ["cwd", "signal", "modelRegistry"] as const;

export interface HerdrToolHost {
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly modelRegistry?: never;
}

export class HostCapabilityError extends Error {
  readonly code = "HOST_CAPABILITY_UNAVAILABLE" as const;
}

export function hostContext(host: HerdrToolHost): ExtensionContext {
  const allowed = new Set<string>(HOST_FIELDS);
  return new Proxy(host, {
    get(target, key) {
      if (typeof key === "symbol") return undefined;
      if (!allowed.has(key)) throw new HostCapabilityError(`MCP host does not provide ${key}`);
      return target[key as keyof HerdrToolHost];
    }
  }) as unknown as ExtensionContext;
}
```

The single `as unknown as ExtensionContext` cast is the whole Pi-type seam. A unit test asserts each of the seven tools reads only allowlisted fields, so an upstream change that starts reading a new host field fails closed with `HOST_CAPABILITY_UNAVAILABLE` instead of silently reading `undefined`.

```ts
// src/mcp/adapter.ts
export interface McpToolDescriptor {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: { readonly type: "object"; readonly [key: string]: unknown };
}

export interface McpCallOutcome {
  readonly content: ReadonlyArray<{ type: "text"; text: string }>;
  readonly isError?: true;
}

export function describeTools(surface: HerdrToolSurface): McpToolDescriptor[];
export function callTool(request: {
  surface: HerdrToolSurface;
  name: string;
  args: unknown;
  host: HerdrToolHost;
  callId: string;
}): Promise<McpCallOutcome>;
```

### Input schema mapping

- The published `inputSchema` is a structural clone (`JSON.parse(JSON.stringify(schema))`) of the shared `parameters` schema. Schemas are never rewritten by hand.
- A root with `type: "object"` is published unchanged.
- A union root (`anyOf` of object variants, used by `herdr_inspect`, `herdr_communicate`, `herdr_jobs`, and the topology schemas) is published as `{ "type": "object", "anyOf": [...variants] }`. Each variant keeps its own `additionalProperties: false`; no `additionalProperties` is added at the root, because a root `false` with no `properties` would reject every argument object.
- Any other root shape is a startup failure. No permissive fallback schema is published.
- Authoritative validation is `Value.Check(definition.parameters, args)` inside the adapter, before `execute`. Failures return the first three `Value.Errors` entries as `INVALID_INPUT`. Missing or `null` arguments become `{}` so the no-argument `herdr_inspect` form keeps working.

### Result and error mapping

- Success: the shared `content` text blocks are returned verbatim, followed by one `herdr-details` text block containing bounded JSON `details` when `details` is present. `structuredContent` and `outputSchema` are not published in this slice.
- Bounds: total response bytes are capped by `MCP_RESULT_MAX_BYTES` (60000) with the existing `\n[output truncated]` marker. The details block is truncated first, then the shared blocks. Existing per-tool bounds (`MAX_PROFILE_RESULT_BYTES`, `JOB_OUTPUT_LIMITS`, CLI evidence limits) are unchanged and applied first.
- Tool failures: returned as a tool result with `isError: true` and a single bounded JSON text block `{ "code", "message", "details" }`, using the error's own `code` when present and `INTERNAL_ERROR` otherwise. `ABORTED` is reported with its own code, never as success.
- Protocol failures: an unknown tool name is a JSON-RPC `MethodNotFound`. Argument validation and execution failures are tool results with `isError: true` so the model can see and correct them.
- Redaction: the adapter serializes only the `details` the shared tools already produce, which strip environment fields and bound identifiers. The adapter adds no new evidence source and never echoes process environment.
- Cancellation: the SDK request `signal` is the tool `AbortSignal` and the `host.signal`. `onUpdate` is not supplied; there are no MCP progress notifications in this slice.

### Startup gating

`src/mcp/run.ts` performs these checks in order, before connecting the transport. Any failure writes one bounded stderr line and exits non-zero with no tools registered and no CLI call made.

1. `HERDR_ENV === "1"`.
2. `readInjectedContext(process.env)` reports `idsPresent && idsValid`, giving the authoritative workspace/tab/pane context.
3. `CLAUDE_PROJECT_DIR` is present, absolute (`path.isAbsolute`), and an existing directory (`fs.stat().isDirectory()`).

The resolved `CLAUDE_PROJECT_DIR` is used as both the profile-discovery `projectCwd` and the operational `cwd`. `process.cwd()` is never read, and no path is derived from `import.meta.url` except the bundled profile directory, which keeps its current module-relative resolution.

Herdr CLI compatibility is not probed at startup. It stays per-call through the existing `preflightCompatibility` seam, so the health contract, error codes, and fail-closed behavior are identical to the Pi host.

### Runtime lifetime

- On start: one `HerdrCli`, one `RuntimeOwnership`, and one `JobRegistry` with no `onTerminal` notification and no wait-job UI.
- Ownership is memory-only and scoped to the MCP process. It survives Claude turns and `/clear`, and is lost on server restart. Herdr resources are never closed or deleted on reset.
- On stdin close, `SIGINT`, or `SIGTERM`: `jobs.shutdown()` then `resetOwnership(ownership)`, then exit 0. Detached wait jobs are marked `shutdown`; no Herdr resource is mutated.

### Wait and jobs semantics under Claude

- `runInBackground: true` registers a detached job in the MCP process. Results are read with `herdr_jobs` `list`, `job`, and `cancel`. There is no `sendMessage`, no steer, no `triggerTurn`, and no self-communication path.
- Foreground waits run to their `timeoutMs` inside one tool call and are subject to the MCP client's tool timeout, which is user configuration.
- Model-backed review needs a model registry the MCP host does not have. The adapter injects a `reviewerFactory` that throws `ReviewerFailure`, which the shared code maps to `REVIEWER_FAILED`. A wait therefore fails closed as soon as `timeoutMs` exceeds `reviewCadenceMinutes * 60000`, foreground or detached.
- The supported manager pattern is bounded waits at or below the configured cadence, repeated as needed, or detached jobs polled with `herdr_jobs`. The owner may raise `wait.reviewCadenceMinutes` up to 30 in `config.json`; that is the existing supervision knob, not a new one.

### Claude package

`claude-manager-plugin/` is packaging plus one conduct skill. It contains no tool logic, no policy, and no permission grants.

```json
// claude-manager-plugin/.claude-plugin/plugin.json
{
  "name": "herdr-manager",
  "description": "Herdr manager conduct skill and the local Herdr tools MCP server",
  "version": "1.0.0",
  "author": { "name": "Herdr Tools" },
  "mcpServers": "./mcp-servers.json"
}
```

```json
// claude-manager-plugin/mcp-servers.json
{
  "mcpServers": {
    "herdr-tools": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/../dist/mcp-server.js"]
    }
  }
}
```

The package lives inside this repository beside `herdr-profiles/role-plugins/`, so `${CLAUDE_PLUGIN_ROOT}/..` is the installed `herdr-tools` root and the built entry is the same code the Pi host runs. If Phase 1 shows `CLAUDE_PROJECT_DIR` is not delivered to MCP subprocesses by default, the server map gains an explicit `"env": { "CLAUDE_PROJECT_DIR": "${CLAUDE_PROJECT_DIR}" }` entry; the server still refuses to guess.

## Tech stack

- TypeScript 5.9, TypeBox schemas and `typebox/value` validation, existing Herdr CLI JSON contracts.
- `@modelcontextprotocol/sdk` low-level `Server` with `ListToolsRequestSchema` and `CallToolRequestSchema` handlers plus `StdioServerTransport`. The low-level server accepts JSON Schema directly, so no Zod schema layer and no schema duplication is introduced.
- `tsc` emit to `dist/` for the MCP entry, because the stdio server runs under plain `node` without Pi's TypeScript loader.
- Vitest unit coverage at 100% and the existing disposable-session integration harness.

## Commands

```bash
npm run test:unit
npm run typecheck
npm run lint
npm run build
npm run build:mcp
HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration
```

Manager session startup, from the manager's project directory inside a Herdr pane:

```bash
claude --model claude-fable-5 \
  --plugin-dir /home/gabriel/.pi/agent/extensions/herdr-tools/claude-manager-plugin
```

Inside a running session the owner switches with `/model fable`. Server registration is verified with `/mcp`, which must list `herdr-tools` with the seven tools.

## Project structure

```text
src/tool-surface.ts                                   shared construction of the seven tools
src/mcp/host.ts                                       env gating, cwd resolution, host capability proxy
src/mcp/adapter.ts                                    descriptors, input validation, result/error mapping
src/mcp/run.ts                                        stdio server wiring and lifecycle
mcp-server.ts                                         argument-free executable shim
tsconfig.build.json                                   emit configuration for dist/
claude-manager-plugin/.claude-plugin/plugin.json      package manifest
claude-manager-plugin/mcp-servers.json                stdio server map
claude-manager-plugin/skills/herdr-manager/SKILL.md   manager conduct skill
test/unit/tool-surface.test.ts                        shared surface identity and wiring
test/unit/mcp-host.test.ts                            gating, cwd rules, capability proxy
test/unit/mcp-adapter.test.ts                         schema, validation, result/error mapping, bounds
test/unit/mcp-run.test.ts                             startup order, lifecycle, shutdown
test/integration/herdr-tools.integration.test.ts      disposable-session MCP evidence
docs/specs/claude-fable-manager-mcp.md
docs/decisions/009-shared-claude-mcp-adapter.md
docs/decisions/010-claude-manager-plugin-conduct.md
```

`dist/` is already ignored by `.gitignore`. `mcp-server.ts` is the only new source file outside the coverage include list (`index.ts` and `src/**/*.ts`); it contains no logic and is verified by integration instead of unit tests.

## Code style

Keep the adapter declarative, bounded, and free of policy:

```ts
const descriptor = (definition: HerdrToolDefinition): McpToolDescriptor => ({
  name: definition.name,
  title: definition.label,
  description: definition.description,
  inputSchema: publishedInputSchema(definition.parameters)
});

function publishedInputSchema(schema: unknown): McpToolDescriptor["inputSchema"] {
  const clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  if (clone.type === "object") return clone as McpToolDescriptor["inputSchema"];
  if (Array.isArray(clone.anyOf)) return { ...clone, type: "object" } as McpToolDescriptor["inputSchema"];
  throw new AdapterContractError("tool parameters are not a publishable object schema");
}
```

No compatibility aliases, no reshaped tool names, no per-host schema variants, and no host-specific policy branches inside `src/tools/`.

## Testing strategy

### Unit

- `src/tool-surface.ts` returns exactly `CORE_TOOL_NAMES` in order, with the same names, labels, descriptions, and schema identity used by the Pi host; `index.ts` registration evidence is unchanged.
- Published descriptors: seven tools, `inputSchema.type === "object"` for every tool, union roots keep every variant with `additionalProperties: false`, and a non-publishable root throws at startup.
- Validation parity: representative accepted and rejected argument sets per tool mirror the existing `schemas`, `wait-schema`, `jobs-schema`, and `topology-schema` unit tests without restating the rules.
- Result mapping: shared text blocks pass through verbatim; the `herdr-details` block is appended and bounded; oversized details truncate before shared blocks; total bytes stay within `MCP_RESULT_MAX_BYTES`.
- Error mapping: typed codes (`INVALID_INPUT`, `TARGET_NOT_FOUND`, `TARGET_AMBIGUOUS`, `CLI_TIMEOUT`, `CLI_PROTOCOL_ERROR`, `PROFILE_CATALOG_UNAVAILABLE`, `REVIEWER_FAILED`, `ABORTED`, `HOST_CAPABILITY_UNAVAILABLE`) survive to `isError: true` payloads; unknown tool names raise `MethodNotFound`.
- Host proxy: allowlisted reads succeed, symbol reads return `undefined`, any other string read throws `HOST_CAPABILITY_UNAVAILABLE`, and each of the seven tools is exercised against a recording proxy to prove the read set.
- Gating: missing/incorrect `HERDR_ENV`, missing or malformed injected IDs, and missing/relative/nonexistent `CLAUDE_PROJECT_DIR` each exit non-zero with no transport connect, no tool registration, and no CLI invocation.
- Cwd rules: the resolved operational `cwd` equals `CLAUDE_PROJECT_DIR` for launch, pane, and tab argv; `process.cwd()` is never consulted.
- Wait host limits: a wait beyond the effective cadence fails with `REVIEWER_FAILED` in both foreground and detached form; a wait within cadence needs no reviewer; detached registration returns a job id retrievable through `herdr_jobs`.
- Lifecycle: shutdown marks jobs `shutdown`, resets ownership, closes no Herdr resource, and exits 0; no notification, steer, or turn-injection call path exists in the MCP host.
- Coverage thresholds stay at 100% statements, branches, functions, and lines for the included sources.

### Integration

Only in the disposable named session `herdr-tools-integration`, extending the existing harness and never touching the live workspace:

- Build `dist/`, spawn `node dist/mcp-server.js` over stdio with `HERDR_ENV=1`, the disposable session's injected IDs, and `CLAUDE_PROJECT_DIR` set to the temporary fixture directory.
- `tools/list` returns the seven names in order with object input schemas.
- `tools/call` for `herdr_inspect` `health` and `collection: "profiles"` returns bounded authoritative evidence with no diagnostics.
- One profile-backed `herdr_launch` into the disposable session preserves the v1 assignment envelope and reports typed effective-profile evidence; the created pane is closed through `herdr_pane` in the same run.
- A detached `herdr_wait` job is created and then observed through `herdr_jobs` without any injected turn or self-communication.
- Startup refusal is asserted for a missing `CLAUDE_PROJECT_DIR` and for `HERDR_ENV` unset.
- Existing provenance, topology, and profile launch assertions stay green.

## Staged tasks

### Phase 0: specification and decisions

- [x] Add this spec plus ADR-009 and ADR-010.
  - Acceptance: product scope, adapter boundary, gating, testing strategy, boundaries, and stop conditions are durable and consistent with ADR-001, ADR-005, ADR-006, ADR-007, and ADR-008.
  - Verify: documentation review, `git diff` inspection, no secrets, documentation-only commit.
  - Files: `docs/specs/claude-fable-manager-mcp.md`, `docs/decisions/009-shared-claude-mcp-adapter.md`, `docs/decisions/010-claude-manager-plugin-conduct.md`.

### Phase 1: contract verification, no product code

- [ ] Verify the four external contracts before writing the adapter.
  - Acceptance: recorded evidence for the plugin manifest/server-map form, how `CLAUDE_PROJECT_DIR` reaches the MCP subprocess, headless importability of the shared modules in plain Node, and the installed SDK's list/call handler and `signal` shape.
  - Verify: throwaway probe in the scratch directory plus `/mcp` output from a disposable manager session; results appended to this spec.
  - Files: this spec only.
  - Checkpoint: if the shared modules cannot be imported headlessly, add an injected renderer seam in `src/tools/` rather than duplicating any tool logic.

### Phase 2: shared tool surface extraction

- [ ] Extract `src/tool-surface.ts` with typed dependencies and move `CORE_TOOL_NAMES`, re-exporting it from `index.ts`.
  - Acceptance: no behavior change in the Pi host; registration, ordering, descriptions, and schemas are identical; coverage stays 100%.
  - Verify: `npm run test:unit`, `npm run typecheck`, `npm run lint`.
  - Files: `src/tool-surface.ts`, `index.ts`, `test/unit/tool-surface.test.ts`, `test/unit/registration.test.ts`.

### Phase 3: MCP host and adapter

- [ ] Add `@modelcontextprotocol/sdk`, the three `src/mcp/` modules, the root shim, `tsconfig.build.json`, and the `build:mcp` script.
  - Acceptance: gating, cwd resolution, capability proxy, schema publication, validation, bounded result/error mapping, cancellation, and shutdown all behave as specified; `@modelcontextprotocol/sdk` is the only added runtime dependency; `dist/mcp-server.js` starts and lists seven tools.
  - Verify: `npm run test:unit`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run build:mcp`.
  - Files: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `src/mcp/host.ts`, `src/mcp/adapter.ts`, `src/mcp/run.ts`, `mcp-server.ts`, `test/unit/mcp-host.test.ts`, `test/unit/mcp-adapter.test.ts`, `test/unit/mcp-run.test.ts`.

### Phase 4: Claude package and conduct skill

- [ ] Add `claude-manager-plugin/` with the manifest, server map, and `herdr-manager` skill.
  - Acceptance: the package contains no tool logic and no permission grants; the skill states manager conduct, evidence handling, job polling, the model expectation with report-and-stop on mismatch, and explicit non-authority language.
  - Verify: load the package with `--plugin-dir` in a disposable manager session; `/mcp` lists `herdr-tools` with seven tools; the skill is discoverable.
  - Files: `claude-manager-plugin/**`.

### Phase 5: integration evidence and documentation

- [ ] Extend the disposable-session integration suite and document installation in the existing README structure.
  - Acceptance: every integration assertion in the testing strategy passes; the live workspace is untouched; README documents installation, the manager launch command, and the `herdr_jobs` polling model.
  - Verify: `HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration`, then the full command list in order.
  - Files: `test/integration/herdr-tools.integration.test.ts`, `README.md`.

### Phase 6: optional shared wording alignment

- [ ] Make the `herdr_jobs` description host-neutral, replacing "owned by this Pi session" with wording covering both hosts.
  - Acceptance: one shared string changed in `src/tools/jobs.ts`; no per-host description branch is introduced.
  - Verify: `npm run test:unit` with any affected registration assertion updated.
  - Files: `src/tools/jobs.ts`, `test/unit/*`.

## Boundaries

### Always

- Keep one shared tool implementation, one profile resolver, and one catalog for both hosts.
- Keep exact targeting, authoritative post-state reads, bounded evidence, and the mandatory v1 provenance envelope.
- Fail closed on missing environment gating, missing project directory, unknown tools, unpublishable schemas, invalid arguments, and unavailable host capabilities.
- Keep ownership in memory, per host process, and never close Herdr resources on reset.
- Keep integration work inside the disposable named session.

### Ask first

- Publishing `outputSchema`/`structuredContent`, MCP progress notifications, or MCP resources and prompts.
- Adding a Claude worker profile with Herdr lifecycle tools, or a `manager-claude` launch profile.
- Adding a headless wait reviewer for the MCP host, or changing the review cadence policy.
- Raising the adapter response bounds or the existing per-tool bounds.
- Exposing the adapter over anything other than local stdio.

### Never

- Add a raw-shell Herdr MCP tool, a native subagent profile, or an eighth tool.
- Duplicate schemas, policy, bounds, or provenance in a host adapter.
- Trust subprocess `cwd`, plugin installation paths, or module-relative paths for the project directory.
- Inject turns, steer the manager, or let the adapter communicate with its own session.
- Let the skill or package claim owner authority, grant permissions, or claim model enforcement.
- Add compatibility parsing, profile-format redesign, monorepo conversion, or unrelated cleanup in this slice.

## Success criteria

- [ ] A Claude Fable manager session in a Herdr pane lists and calls exactly the seven tools through the local stdio adapter.
- [ ] Pi and Claude hosts run the same tool implementation and profile catalog, with no duplicated schema or policy.
- [ ] `@modelcontextprotocol/sdk` is the only added runtime dependency.
- [ ] Startup refuses to serve without `HERDR_ENV=1`, valid injected IDs, and a valid absolute existing `CLAUDE_PROJECT_DIR`, and never falls back to subprocess or module paths.
- [ ] Profile discovery, prompt sources, bounded fallback, ownership, and v1 provenance behave identically across hosts.
- [ ] Detached waits are created and polled through `herdr_jobs`, with no self-communication and no automatic turn injection.
- [ ] Waits beyond the effective review cadence fail closed with a typed reviewer error in both foreground and detached form.
- [ ] The package adds only packaging and a conduct skill; model selection remains launch/user configuration and mismatch is reported, not enforced.
- [ ] Unit coverage stays at 100% for included sources; integration passes only in the disposable named session.

## Stop conditions

Stop and report instead of improvising when:

- `CLAUDE_PROJECT_DIR` cannot be delivered to the MCP subprocess in any documented form.
- The plugin manifest or server-map contract differs from Phase 1 evidence in a way that requires a different packaging shape.
- The shared modules cannot be imported in a plain Node process and the renderer seam does not resolve it.
- Any tool would need a host-specific schema, policy, bound, or provenance change to work under MCP.
- The installed SDK requires a schema layer that would duplicate the TypeBox schemas.
- Serving Claude would require an eighth tool, a raw-shell tool, or relaxed permission behavior.
- 100% unit coverage cannot be maintained without weakening an existing strict test.
- Any integration step would touch the live workspace instead of the disposable named session.

## Unresolved questions

1. Wait supervision on the MCP host. A wait longer than `wait.reviewCadenceMinutes` fails closed because there is no model registry. The owner decides between raising the cadence to at most 30 minutes, repeated bounded waits, or authorizing a headless reviewer in a later slice.
2. Whether `CLAUDE_PROJECT_DIR` arrives in the MCP subprocess environment by default or needs an explicit expansion entry in the server map. Phase 1 records the answer.
3. Whether the MCP client tool timeout in the manager session is long enough for the intended bounded foreground waits, or whether the manager should use detached jobs exclusively. This stays launch/user configuration either way.
4. Whether `structuredContent` with a published `outputSchema` is worth adding once the details shapes are stable; the union-heavy shapes make a schema a duplication risk today.
5. Whether the manager session should later get a Herdr-visible identity distinct from its pane label for provenance display, which is a Herdr core concern rather than an adapter concern.
