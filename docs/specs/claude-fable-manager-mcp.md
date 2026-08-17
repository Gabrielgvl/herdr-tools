# Spec: Claude Fable manager MCP adapter

## Status

Implemented and accepted through Phase 5, including owner dogfooding of a live Fable manager session. Phase 6 (optional shared wording alignment) is not started.

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
2. Claude Code loads a local package through `--plugin-dir`, reads `.claude-plugin/plugin.json`, and resolves its `mcpServers` field to a sibling `mcp-servers.json` holding a top-level server map with no `mcpServers` wrapper, as the live Honcho plugin in this environment does. `${CLAUDE_PLUGIN_ROOT}` expands to the package root inside that map.
3. Subprocess working directory is never trusted. `CLAUDE_PROJECT_DIR` must be present, absolute, and an existing directory; it is the profile-discovery `projectCwd` and the operational `cwd` for launch/pane/tab. There is no fallback.
4. Claude Code delivers `CLAUDE_PROJECT_DIR` to the MCP server environment. Confirmed in Phase 4: it is exported to MCP subprocesses by default, so no expansion entry is carried. The server never substitutes another value.
5. `typebox` schemas are JSON Schema documents and can be published as MCP `inputSchema` after a structural adaptation for union roots. The adapter validates arguments with `typebox/value` before invoking a tool, which is exactly the guarantee the Pi host provides today.
6. The shared tool modules can be imported in a plain Node process. They already import `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` for `truncateTail` and the compact renderers.
7. MCP client tool timeouts and the primary model are launch/user configuration. The adapter does not read, set, or claim to enforce either.
8. `config.json` stays the single shared settings file at `/home/gabriel/.pi/agent/extensions/herdr-tools/config.json` with its existing 1..30 minute `wait.reviewCadenceMinutes` and reviewer model fields.
9. Model-backed wait review is a Pi host capability. The MCP host has no model registry, so a wait longer than the effective review cadence fails closed instead of running unsupervised.

## Architecture

### Hosts and shared core

```text
Pi extension host                     MCP host
index.ts                              src/mcp-server.ts -> src/mcp/run.ts
  pi.registerTool(...)                  Server(list_tools/call_tool) + StdioServerTransport
  ExtensionContext                      src/mcp/host.ts (gating, cwd, capability proxy)
  WaitJobsUi + sendMessage              herdr_jobs polling only
            \                        /
             src/tool-surface.ts (the seven ToolDefinitions)
             src/tools/*.ts  src/profiles/*  src/cli.ts  src/health.ts
             src/ownership.ts src/job-registry.ts src/provenance.ts src/settings.ts
```

`src/tool-surface.ts` becomes the one place that constructs the seven tools from typed dependencies. `index.ts` keeps its Pi-only concerns (command registration, session events, wait-job UI, terminal notifications) and consumes the same surface. `CORE_TOOL_NAMES` moves to `src/tool-surface.ts` and is re-exported from `index.ts` so existing imports and tests keep working.

`readInjectedContext` and `createPreflight` move with it, because both hosts need the injected Herdr identity and the per-call compatibility preflight, and `src/mcp/` must not import the Pi extension entry to reach them. Both are re-exported from `index.ts` as well.

### Typed adapter boundary

The shared tools read exactly three fields from the host context: `cwd` (launch, pane, tab), `signal` (communicate, pane, tab fallback), and `modelRegistry` (wait reviewer only). The MCP host provides only `cwd` and `signal` and denies everything else at runtime, `modelRegistry` included: the host injects a throwing `reviewerFactory`, so nothing may reach `createPiModelReviewer`. A `modelRegistry` read is proof that the reviewer seam was bypassed and must fail loudly rather than resolve to `undefined`.

```ts
// src/mcp/host.ts
export const HOST_FIELDS = ["cwd", "signal"] as const;

export interface HerdrToolHost {
  readonly cwd: string;
  readonly signal: AbortSignal;
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

The single `as unknown as ExtensionContext` cast is the whole Pi-type seam. A unit test asserts each of the seven tools reads only `cwd` and `signal`, so an upstream change that starts reading `modelRegistry` or any other host field fails closed with `HOST_CAPABILITY_UNAVAILABLE` instead of silently reading `undefined`.

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
- Duplicate suppression: the `herdr-details` block is omitted when a shared text block is already the complete serialization of the same `details` value, which is exactly what `herdr_jobs` returns. Equality is a JSON round trip, so a projection, a truncated rendering, or any non-JSON text still gets its own block. The rule can only remove a byte-for-byte redundant copy; it can never hide evidence that is absent, partial, or differently shaped.
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

Any failure that escapes startup entirely is written by `src/mcp-server.ts` through the same sanitizing, bounded single-line helper the refusals use, so the entry never emits raw multi-line error text into the client's log.

### Process execution on the MCP host

`createNodeExec` is the MCP host's equivalent of Pi's `exec`, and it must produce the same typed failures:

- A process that could never be spawned rejects with its own error, so `HerdrCli` maps a missing `herdr` binary to `CLI_NOT_FOUND` with the spawn failure as `cause`, exactly as it does under Pi. Resolving a spawn failure as an ordinary non-zero exit would discard the evidence and mislabel it `CLI_PROTOCOL_ERROR`. A child that already emitted output or exited is not a spawn failure and still settles with its evidence.
- Both pipes are decoded through a streaming UTF-8 decoder, so a code point split across two chunks cannot corrupt evidence.
- Settling after `exit` waits one `EXEC_IDLE_GRACE_MS` (100ms) window, re-armed by each late chunk. This is a documented tradeoff: `close` cannot be relied on because a detached Herdr descendant can hold the inherited pipe open indefinitely, while settling on `exit` alone would drop queued output. A well-behaved child that emits `close` settles immediately and pays nothing; a child with an inherited pipe pays exactly one grace period; output arriving more than one grace period after the last chunk is lost rather than held forever.

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
  "name": "herdr-tools",
  "description": "Herdr manager conduct skill and the local Herdr tools MCP server",
  "version": "1.0.0",
  "author": { "name": "Herdr Tools" },
  "mcpServers": "./mcp-servers.json"
}
```

```json
// claude-manager-plugin/mcp-servers.json
{
  "herdr": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/../dist/src/mcp-server.js"]
  }
}
```

`mcp-servers.json` is a top-level server map with no `mcpServers` wrapper, matching the live Honcho plugin in this environment. The wrapper belongs only to project `.mcp.json` files.

The manifest `name` and the server key are pinned, because Claude derives tool names from both: the seven tools appear as `mcp__plugin_herdr-tools_herdr__herdr_inspect` through `mcp__plugin_herdr-tools_herdr__herdr_tab`. Renaming either segment rewrites every allowlist entry an owner or launch configuration may reference, so a rename is an owner decision, not an implementation detail.

The package lives inside this repository beside `herdr-profiles/role-plugins/`, so `${CLAUDE_PLUGIN_ROOT}/..` is the installed `herdr-tools` root and the built entry is the same code the Pi host runs. The server map carries no `env` mapping: Claude Code exports `CLAUDE_PROJECT_DIR` to MCP server subprocesses itself, confirmed by the official plugin reference and by the running Honcho plugin's subprocesses in this installation (Phase 4 evidence). The server still refuses to guess if it is ever absent.

### Local plugin loading only

The `${CLAUDE_PLUGIN_ROOT}/..` path is valid only while the package is loaded from its place in this repository with `--plugin-dir`. Marketplace installation caches the package directory alone, so the parent repository, its `dist/`, and its `node_modules/` are gone and the server command cannot resolve.

This slice is therefore constrained to local `--plugin-dir` loading, and marketplace publication is blocked. A self-contained package would need its own bundled server build and its own dependency copy, which is a packaging redesign this slice does not authorize. The constraint is stated in the boundaries and stop conditions; the follow-up option is recorded as an unresolved question rather than half-built now.

## Tech stack

- TypeScript 5.9, TypeBox schemas and `typebox/value` validation, existing Herdr CLI JSON contracts.
- `@modelcontextprotocol/sdk` low-level `Server` with `ListToolsRequestSchema` and `CallToolRequestSchema` handlers plus `StdioServerTransport`. The low-level server accepts JSON Schema directly, so no Zod schema layer and no schema duplication is introduced.
- `tsc` emit to `dist/` through `tsconfig.build.json`, because the stdio server runs under plain `node` without Pi's TypeScript loader. The entry is `src/mcp-server.ts`, emitted to `dist/src/mcp-server.js`.
- Vitest unit coverage at 100% and the existing disposable-session integration harness.

## Commands

```bash
npm run test:unit
npm run typecheck
npm run lint
npm run build
npm run build:mcp
npm run validate:plugin
HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration -- --session herdr-tools-integration
```

`scripts/test-integration.ts` is authoritative for the last command: the session argument is optional and defaults to `herdr-tools-integration`, and any other value is refused before Vitest starts. It is written out here and in the README so the disposable session is visible at the call site; omitting it changes nothing.

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
src/mcp-server.ts                                     argument-free executable entry
tsconfig.build.json                                   emit configuration for dist/
claude-manager-plugin/.claude-plugin/plugin.json      package manifest
claude-manager-plugin/mcp-servers.json                stdio server map
claude-manager-plugin/skills/herdr-manager/SKILL.md   manager conduct skill
test/unit/tool-surface.test.ts                        shared surface identity and wiring
test/unit/mcp-host.test.ts                            gating, cwd rules, capability proxy
test/unit/mcp-adapter.test.ts                         schema, validation, result/error mapping, bounds
test/unit/mcp-run.test.ts                             startup order, lifecycle, shutdown
test/unit/claude-plugin.test.ts                       package inventory, manifest, server map, skill conduct
test/integration/herdr-mcp.integration.test.ts        disposable-session MCP evidence
docs/specs/claude-fable-manager-mcp.md
docs/decisions/009-shared-claude-mcp-adapter.md
docs/decisions/010-claude-manager-plugin-conduct.md
```

`dist/` is already ignored by `.gitignore`.

The executable entry lives at `src/mcp-server.ts` so it is a first-class input to every gate: `tsconfig.json`'s existing `src/**/*.ts` include typechecks it, `eslint .` lints it, and `tsconfig.build.json` (`rootDir: "."`, `outDir: "dist"`, include `index.ts` and `src/**/*.ts`) emits it to `dist/src/mcp-server.js`, which is the path the server map runs. No untyped root shim is introduced.

The entry contains only an argument-free call into `src/mcp/run.ts` and a top-level failure exit, so it is the one file listed in an explicit `coverage.exclude` entry in `vitest.config.ts`. The 100% thresholds stay in force for every other included source, and the entry is verified by the disposable-session integration run that spawns `dist/src/mcp-server.js` for real.

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
- Host proxy: `cwd` and `signal` reads succeed, symbol reads return `undefined`, `modelRegistry` and any other string read throw `HOST_CAPABILITY_UNAVAILABLE`, and each of the seven tools is exercised against a recording proxy to prove the read set is exactly `cwd` and `signal`.
- Gating: missing/incorrect `HERDR_ENV`, missing or malformed injected IDs, and missing/relative/nonexistent `CLAUDE_PROJECT_DIR` each exit non-zero with no transport connect, no tool registration, and no CLI invocation.
- Cwd rules: the resolved operational `cwd` equals `CLAUDE_PROJECT_DIR` for launch, pane, and tab argv; `process.cwd()` is never consulted.
- Wait host limits: a wait beyond the effective cadence fails with `REVIEWER_FAILED` in both foreground and detached form; a wait within cadence needs no reviewer; detached registration returns a job id retrievable through `herdr_jobs`.
- Lifecycle: shutdown marks jobs `shutdown`, resets ownership, closes no Herdr resource, and exits 0; no notification, steer, or turn-injection call path exists in the MCP host.
- Coverage thresholds stay at 100% statements, branches, functions, and lines for the included sources, with `src/mcp-server.ts` the only `coverage.exclude` entry.

### Integration

Only in the disposable named session `herdr-tools-integration`, extending the existing harness and never touching the live workspace:

- Build `dist/`, spawn `node dist/src/mcp-server.js` over stdio with `HERDR_ENV=1`, the disposable session's injected IDs, and `CLAUDE_PROJECT_DIR` set to the temporary fixture directory.
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

- [~] Verify the four external contracts before writing the adapter. Recorded below; the packaging probe stays with Phase 4.
  - Acceptance: recorded evidence for the plugin manifest and top-level server-map form, how `CLAUDE_PROJECT_DIR` reaches the MCP subprocess, headless importability of the shared modules in plain Node, and the installed SDK's list/call handler and `signal` shape.
  - Verify: throwaway probe in the scratch directory plus `/mcp` output from a disposable manager session, which must list the server and the `mcp__plugin_herdr-tools_herdr__*` tool names; results appended to this spec.
  - Files: this spec only.
  - Checkpoint: if the shared modules cannot be imported headlessly, add an injected renderer seam in `src/tools/` rather than duplicating any tool logic.

#### Phase 1 evidence

Probes ran in the scratch directory against the installed dependencies and the emitted `dist/`; no product file was written for them.

- **Headless importability.** Compiling the repository with `rootDir: "."` and importing the emitted `dist/index.js` and `dist/src/tools/*.js` under plain `node` v25.9 constructs all seven tools with their renderers. `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `@earendil-works/pi-ai/compat` all load outside Pi, so no renderer seam is needed.
- **SDK contract (`@modelcontextprotocol/sdk` 1.30.0).** The low-level `Server` with `ListToolsRequestSchema` and `CallToolRequestSchema` publishes `inputSchema` verbatim, including a `type: "object"` plus `anyOf` root, and carries `title`. `extra.signal` is an `AbortSignal` that aborts when the client cancels. A thrown `McpError(ErrorCode.MethodNotFound)` surfaces as JSON-RPC `-32601`; an `isError: true` result passes through as a normal result. `arguments` may arrive `undefined`. No Zod layer and no schema duplication is required. The `Server` class carries an `@deprecated` JSDoc tag pointing at `McpServer`; it is not deprecated behaviour and no lint or typecheck gate objects.
- **TypeBox publication and validation.** `JSON.parse(JSON.stringify(schema))` yields `anyOf` roots with no root `additionalProperties` and per-variant `additionalProperties: false` for `herdr_inspect`, `herdr_communicate`, `herdr_jobs`, `herdr_pane`, and `herdr_tab`, and `type: "object"` roots for `herdr_wait` and `herdr_launch`. `Value.Check` and `Value.Errors` accept union roots. TypeBox 1.3 `ValueError` entries carry `keyword`, `schemaPath`, `instancePath`, `params`, and `message`, and no `path`; the adapter reports the first three as `keyword`, `instancePath`, `schemaPath`, and `message`.
- **Truncation direction.** `truncateTail` from `@earendil-works/pi-coding-agent` keeps the tail and cannot bound a single-line JSON payload without dropping the head, and `truncateHead` returns empty content for a single line over the byte limit. The adapter therefore bounds its own payloads by bytes from the head, never splitting a code point, and keeps the existing `\n[output truncated]` marker. Per-tool bounds are unchanged.
- **`CLAUDE_PROJECT_DIR`.** It is not present in the ambient Claude Code process environment in this installation, so Phase 1 could not tell from the parent process whether the client delivers it to an MCP subprocess. Phase 4 settled it: default delivery is authoritative and no `env` mapping is needed. See the Phase 4 evidence below. The live Honcho plugin confirms the top-level server-map shape with `${CLAUDE_PLUGIN_ROOT}` expansion.
- **Emission and startup.** `tsconfig.build.json` emits `dist/src/mcp-server.js` and `dist/index.js`; the entry stays inside `src/`, so typecheck, lint, and emit all cover it and no root shim is needed. `node dist/src/mcp-server.js` refuses with one bounded stderr line and exit 1 for a missing `HERDR_ENV`, missing or malformed injected identifiers, and a missing, relative, or nonexistent `CLAUDE_PROJECT_DIR`; with valid gating it lists the seven tools in order with object schemas, and `herdr_inspect` `collection: "profiles"` returns the same 11 bundled profiles with no diagnostics that the Pi host loads. The bundled catalog is anchored on the package manifest, so the source and emitted layouts resolve to the same repository root.

### Phase 2: shared tool surface extraction

- [x] Extract `src/tool-surface.ts` with typed dependencies and move `CORE_TOOL_NAMES`, re-exporting it from `index.ts`.
  - Acceptance: no behavior change in the Pi host; registration, ordering, descriptions, and schemas are identical; coverage stays 100%.
  - Verify: `npm run test:unit`, `npm run typecheck`, `npm run lint`.
  - Files: `src/tool-surface.ts`, `index.ts`, `test/unit/tool-surface.test.ts`, `test/unit/registration.test.ts`.

### Phase 3: MCP host and adapter

- [x] Add `@modelcontextprotocol/sdk`, the three `src/mcp/` modules, the compiled entry, `tsconfig.build.json`, and the `build:mcp` script.
  - Acceptance: gating, cwd resolution, capability proxy, schema publication, validation, bounded result/error mapping, cancellation, and shutdown all behave as specified; `@modelcontextprotocol/sdk` is the only added runtime dependency; `src/mcp-server.ts` is typechecked, linted, and emitted; `dist/src/mcp-server.js` starts and lists seven tools.
  - Verify: `npm run test:unit`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run build:mcp`.
  - Files: `package.json`, `tsconfig.build.json`, `vitest.config.ts`, `src/mcp/host.ts`, `src/mcp/adapter.ts`, `src/mcp/run.ts`, `src/mcp-server.ts`, `test/unit/mcp-host.test.ts`, `test/unit/mcp-adapter.test.ts`, `test/unit/mcp-run.test.ts`.

### Phase 4: Claude package and conduct skill

- [x] Add `claude-manager-plugin/` with the manifest, top-level server map, and `herdr-manager` skill.
  - Acceptance: the package contains no tool logic and no permission grants; the manifest `name` is `herdr-tools` and the server key is `herdr`, so tools resolve as `mcp__plugin_herdr-tools_herdr__*`; the skill states manager conduct, evidence handling, job polling, the model expectation with report-and-stop on mismatch, and explicit non-authority language.
  - Verify: `npm run validate:plugin`, `test/unit/claude-plugin.test.ts`; then load the package with `--plugin-dir` in a disposable manager session and confirm `/mcp` lists the `herdr` server with seven tools under the expected prefix.
  - Files: `claude-manager-plugin/**`, `test/unit/claude-plugin.test.ts`, `package.json`.

#### Phase 4 evidence

- **Live load.** `claude --plugin-dir ./claude-manager-plugin mcp list` reports `plugin:herdr-tools:herdr: node /home/gabriel/workspace/herdr-tools-claude-mcp/claude-manager-plugin/../dist/src/mcp-server.js - ✔ Connected`, so `${CLAUDE_PLUGIN_ROOT}` expands as specified and the built entry passes its startup gating under a real Claude Code load. `claude --plugin-dir ./claude-manager-plugin plugin details herdr-tools` reports skills 1 (`herdr-manager`), agents 0, hooks 0. That inventory prints "MCP servers (0)" because it counts inline manifest entries and this manifest points at the sibling `mcp-servers.json`; `mcp list` is the authority and shows the server registered and connected. The published tool names were not read from a live session's tool list: they follow from the `plugin:herdr-tools:herdr` server id by the same rule the installed Honcho plugin demonstrates (`plugin:honcho:honcho` publishing `mcp__plugin_honcho_honcho__*`). Confirming the exact names in a Fable manager session is left to owner dogfooding.
- **Package contents.** Exactly three files: `.claude-plugin/plugin.json`, `mcp-servers.json`, and `skills/herdr-manager/SKILL.md`. No `.claude/agents`, no hooks, no settings, no `allowedTools`/`disallowedTools`, no permission-mode field. `claude plugin validate ./claude-manager-plugin` passes on Claude Code 2.1.233, and `test/unit/claude-plugin.test.ts` pins the manifest shape, the single `herdr` server key, the resolved entry path, the derived `mcp__plugin_herdr-tools_herdr__*` names, and the required skill conduct.
- **`CLAUDE_PROJECT_DIR` delivery.** Default delivery is authoritative; no `env` mapping is carried. Two sources agree.
  - Official documentation (Claude Code plugins reference): `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, and `${CLAUDE_PROJECT_DIR}` "are exported as environment variables to hook processes and to MCP and LSP server subprocesses", with `${CLAUDE_PROJECT_DIR}` resolving to the project root.
  - Live local example: the installed Honcho plugin registers its stdio server through the same top-level `mcp-servers.json` shape and carries no `env` mapping. Its running MCP subprocesses inherit `CLAUDE_PROJECT_DIR` set to each session's own project directory, alongside `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, and the injected `HERDR_ENV`/`HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`/`HERDR_PANE_ID` identity this server also gates on. Two concurrent sessions in different project directories each delivered their own value, so the variable tracks the session rather than the client installation.
  - Adding a redundant `"env": { "CLAUDE_PROJECT_DIR": "${CLAUDE_PROJECT_DIR}" }` entry was therefore rejected: it would be a second source of truth for a value the client already supplies. The startup check is unchanged and still fails closed when the variable is absent, relative, or not an existing directory, so a future client that stops delivering it produces a visible refusal rather than a wrong project directory.

### Phase 5: integration evidence and documentation

- [x] Extend the disposable-session integration suite and document installation in the existing README structure.
  - Acceptance: every integration assertion in the testing strategy passes; the live workspace is untouched; README documents installation, the manager launch command, and the `herdr_jobs` polling model.
  - Verify: `HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration -- --session herdr-tools-integration`, then the full command list in order.
  - Files: `test/integration/herdr-mcp.integration.test.ts`, `README.md`.

#### Phase 5 evidence

- The MCP evidence lives in a second suite, `test/integration/herdr-mcp.integration.test.ts`, beside the existing extension suite. Vitest runs integration files sequentially (`fileParallelism: false`, `maxWorkers: 1`), and each suite owns a complete session lifecycle, so neither depends on the other's state.
- The server is bound to the disposable session through `HERDR_SOCKET_PATH`, which the spawned `herdr` client processes inherit. The default session's workspace, tab, and pane IDs are captured before the run and asserted unchanged after it.
- **Herdr runtime constraint.** Herdr 0.8.0 attaches a shell to a newly created pane asynchronously and exposes no readiness field on the pane record, so `agent start` immediately after `tab create` intermittently returns `agent_pane_busy` (observed in 1 of 3 back-to-back attempts). This affects the Pi host identically and is not introduced by this slice. The suite therefore launches into a pane created earlier in the same run and adds one bounded settle; the launch assertion itself is unchanged and a failure is still a failure. A readiness signal on the pane record would remove the settle.
- `herdr_communicate` is exercised with `steer`, because the worker is still working on its assignment prompt and `prompt` correctly refuses to interrupt a working target with `TARGET_BUSY`. Both carry the same mandatory v1 envelope, which is then observed in authoritative pane output.

#### Published schema parity

A dogfood session reported that the published `herdr_inspect` schema looked looser than server validation after invalid mixed shapes such as `{mode:"context", collection:...}` were tried. It is not: publication and validation accept exactly the same inputs.

- The published document is the shared TypeBox document plus the root `type: "object"` MCP requires. Nothing is dropped, rewritten, or relaxed, and a unit test asserts that exact relationship for all seven tools. Adding a root `type` can only narrow.
- `herdr_inspect` publishes six `anyOf` variants, each with `additionalProperties: false`. A field belonging to another mode is therefore an additional property in the mode it was mixed into, which is why `{mode:"context", collection:"panes"}` and `{mode:"context", profile:"..."}` are rejected. Validation rejects them for the identical reason, reporting `keyword: "additionalProperties"`.
- A semantic regression test evaluates a table of valid variants and the reported invalid mixed, missing-field, unknown-mode, and extra-field shapes against **both** the published document and the shared schema, and requires the same verdict from each; every rejected case is also driven through `callTool` and must return `INVALID_INPUT`. Equivalent cases cover the other six tools.
- The integration suite compares the exact `tools/list` schema emitted by the built server over stdio with `publishedInputSchema(definition.parameters)` for all seven tools and requires deep equality, then calls a mixed shape over the wire and requires `INVALID_INPUT` with `additionalProperties`.

The contract is unchanged. What the client does not do is validate arguments locally before sending, so an invalid call reaches the server and is refused there; from inside the session that looks like a stricter server, but the same schema was published. The manager skill now states the exclusive `herdr_inspect` shapes and says explicitly that a rejection means the argument was wrong, not that the server is stricter than advertised.

#### Dogfood acceptance evidence

Reported by the owner-side dogfood run of a primary `claude-fable-5` session loaded with local `--plugin-dir`:

- All seven published tool names were called successfully from the Fable manager session.
- `scout-pi` launched as Luna low with no fallback taken.
- A detached wait job was created and observed to completion through `herdr_jobs`.
- The assignment and prompt envelopes both showed `[HERDR AGENT MESSAGE v1]` with `authority: agent; not user/owner`.
- The pane and tab IDs created during the run were closed, and topology returned to the pre-dogfood count.

Independently re-verified here: no global installation and no configuration write occurred. `~/.claude/plugins/installed_plugins.json` contains no `herdr` entry, `~/.claude/plugins/cache/` holds no `herdr-tools` package, and no MCP server was written into user or project configuration. The only `~/.claude.json` traces are usage counters Claude Code maintains automatically — `pluginUsage["herdr-tools@inline"]`, whose `@inline` suffix marks a `--plugin-dir` load rather than an install, and `skillUsage["herdr-tools:herdr-manager"]`.

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
- Keep the package loadable only from its place in this repository with `--plugin-dir`, and keep the manifest name `herdr-tools` with server key `herdr` so allowlist entries stay stable.

### Ask first

- Publishing `outputSchema`/`structuredContent`, MCP progress notifications, or MCP resources and prompts.
- Making the package self-contained for marketplace publication, which needs its own bundled server build and dependency copy.
- Renaming the manifest or the server key, which rewrites every `mcp__plugin_herdr-tools_herdr__*` allowlist entry.
- Adding a Claude worker profile with Herdr lifecycle tools, or a `manager-claude` launch profile.
- Adding a headless wait reviewer for the MCP host, or changing the review cadence policy.
- Raising the adapter response bounds or the existing per-tool bounds.
- Exposing the adapter over anything other than local stdio.

### Never

- Add a raw-shell Herdr MCP tool, a native subagent profile, or an eighth tool.
- Duplicate schemas, policy, bounds, or provenance in a host adapter.
- Trust subprocess `cwd`, plugin installation paths, or module-relative paths for the project directory.
- Publish the package to a marketplace or any cached install path while the server command depends on `${CLAUDE_PLUGIN_ROOT}/..`.
- Inject turns, steer the manager, or let the adapter communicate with its own session.
- Let the skill or package claim owner authority, grant permissions, or claim model enforcement.
- Add compatibility parsing, profile-format redesign, monorepo conversion, or unrelated cleanup in this slice.

## Success criteria

- [x] A Claude Fable manager session in a Herdr pane lists and calls exactly the seven tools through the local stdio adapter. Proven twice: the disposable-session integration run lists and calls all seven over real stdio, and the dogfood run called all seven from a primary `claude-fable-5` session loaded with local `--plugin-dir`.
- [x] Pi and Claude hosts run the same tool implementation and profile catalog, with no duplicated schema or policy.
- [x] `@modelcontextprotocol/sdk` is the only added runtime dependency.
- [x] Startup refuses to serve without `HERDR_ENV=1`, valid injected IDs, and a valid absolute existing `CLAUDE_PROJECT_DIR`, and never falls back to subprocess or module paths.
- [x] Profile discovery, prompt sources, bounded fallback, ownership, and v1 provenance behave identically across hosts.
- [x] Detached waits are created and polled through `herdr_jobs`, with no self-communication and no automatic turn injection.
- [x] Waits beyond the effective review cadence fail closed with a typed reviewer error in both foreground and detached form.
- [x] The package adds only packaging and a conduct skill; model selection remains launch/user configuration and mismatch is reported, not enforced.
- [x] The package loads from this repository with `--plugin-dir` and its tools resolve as `mcp__plugin_herdr-tools_herdr__*`; marketplace publication is documented as blocked rather than half-supported. The dogfood run called all seven published names from a live session, confirming the naming derived from the `plugin:herdr-tools:herdr` server id.
- [x] Unit coverage stays at 100% for included sources with `src/mcp-server.ts` the only exclusion; the entry is typechecked, linted, built, and exercised by integration.

## Stop conditions

Stop and report instead of improvising when:

- `CLAUDE_PROJECT_DIR` cannot be delivered to the MCP subprocess in any documented form.
- The plugin manifest or top-level server-map contract differs from Phase 1 evidence in a way that requires a different packaging shape.
- The manager session needs the package installed from a marketplace or any other cached location, which this slice's server path cannot support.
- Keeping the executable entry inside `src/` conflicts with typecheck, lint, or emit configuration in a way that would force an untyped root shim.
- The shared modules cannot be imported in a plain Node process and the renderer seam does not resolve it.
- Any tool would need a host-specific schema, policy, bound, or provenance change to work under MCP.
- The installed SDK requires a schema layer that would duplicate the TypeBox schemas.
- Serving Claude would require an eighth tool, a raw-shell tool, or relaxed permission behavior.
- 100% unit coverage cannot be maintained without weakening an existing strict test.
- Any integration step would touch the live workspace instead of the disposable named session.

## Unresolved questions

1. Wait supervision on the MCP host. A wait longer than `wait.reviewCadenceMinutes` fails closed because there is no model registry. The owner decides between raising the cadence to at most 30 minutes, repeated bounded waits, or authorizing a headless reviewer in a later slice.
2. ~~Whether `CLAUDE_PROJECT_DIR` arrives in the MCP subprocess environment by default or needs an explicit expansion entry in the server map.~~ Resolved in Phase 4: it arrives by default, documented and observed, so no entry is carried.
3. Whether the MCP client tool timeout in the manager session is long enough for the intended bounded foreground waits, or whether the manager should use detached jobs exclusively. This stays launch/user configuration either way.
4. Whether `structuredContent` with a published `outputSchema` is worth adding once the details shapes are stable; the union-heavy shapes make a schema a duplication risk today.
5. Whether the manager session should later get a Herdr-visible identity distinct from its pane label for provenance display, which is a Herdr core concern rather than an adapter concern.
6. Whether the package should later become self-contained for marketplace installation. That needs a bundled server build and its own dependency copy inside the package, because a cached marketplace install loses the parent repository that `${CLAUDE_PLUGIN_ROOT}/..` resolves to. This slice stays local-only.
