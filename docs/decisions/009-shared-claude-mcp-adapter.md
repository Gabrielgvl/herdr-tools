# ADR-009: Serve Claude through a shared-implementation stdio MCP adapter

## Status

Accepted; extends ADR-001 with a second host. Caller-context resolution is
superseded by [ADR-017](017-mcp-live-caller-context-rebinding.md).

## Date

2026-08-17

## Context

The seven Herdr tools currently exist only as Pi custom tools registered by the `herdr-tools` extension. An interactive Claude Fable session cannot reach them, so a Claude manager would either drive Herdr through raw shell commands or be restricted to delegated worker roles. ADR-007 declined a Claude manager profile precisely because no Claude runtime had Herdr tool parity.

Claude reaches external tools through MCP. Two hosts therefore need the same tool surface. The failure mode to avoid is a second implementation: duplicated schemas, target resolution, bounds, provenance, ownership, or launch policy would let the two hosts disagree about what is safe, and every future policy change would need two correct edits.

The Pi host supplies capabilities the MCP host does not have. Pi tools receive an `ExtensionContext` and read `cwd`, `signal`, and `modelRegistry` from it; Pi also owns the wait-job TUI and the turn-notification channel used when a detached wait finishes. An MCP server is a plain stdio subprocess with no model registry, no UI, and no way to speak into its client's turn loop.

An MCP subprocess also cannot trust its own working directory. Profile discovery and the operational `cwd` for launch, pane, and tab must be the manager session's project directory, not the plugin installation directory, not the module directory, and not whatever directory the client happened to spawn the server from.

## Decision

Expose the existing seven tools to Claude through a local stdio MCP adapter that executes one shared implementation.

`src/tool-surface.ts` becomes the single construction point for `herdr_inspect`, `herdr_communicate`, `herdr_wait`, `herdr_jobs`, `herdr_launch`, `herdr_pane`, and `herdr_tab`, in that order. Both hosts consume it. Schemas, target resolution, bounds, redaction, ownership, prompt sources, launch policy, and the mandatory `[HERDR AGENT MESSAGE v1]` envelope exist exactly once. No eighth tool, no raw-shell tool, no native subagent profile, and no per-host policy branch is added.

The adapter uses the SDK's low-level `Server` with `tools/list` and `tools/call` handlers over `StdioServerTransport`. Published `inputSchema` values are structural clones of the shared TypeBox schemas; a union root is published as `{ "type": "object", "anyOf": [...] }` with per-variant `additionalProperties: false`, and any other root shape is a startup failure. Arguments are validated with `typebox/value` against the same schema before `execute`, which reproduces the guarantee the Pi host gives today. Results return the shared content blocks verbatim plus one bounded `herdr-details` JSON block; failures return `isError: true` with the error's own typed code; an unknown tool name is a JSON-RPC `MethodNotFound`. `structuredContent` and `outputSchema` are not published.

Everything the adapter publishes crosses a model boundary, so three properties are enforced there rather than per tool.

First, redaction. `details` and thrown-error `details` pass through one recursive projection (`modelSafeJson` in `src/redaction.ts`) that drops environment-shaped keys at every nesting depth, including inside arrays and inside records a tool retained verbatim. The tools apply the same redaction where a pane record enters evidence, so the boundary projection is defense in depth rather than the only guard, and an evidence field added upstream later cannot leak by omission. The rule is value-aware in exactly one respect: because environment values are strings by contract, a key is dropped when its projected value carries a string at any depth and kept when it cannot, which is what lets the `herdr_inspect` health result keep reporting its typed `environment` presence booleans without a per-tool exemption.

Second, parseability. A block is bounded as a value, never as serialized text: cutting a serialized object at a byte boundary would publish malformed JSON, so an oversized value is replaced by `{ "truncated": true, "originalBytes": n, "preview": "<head of the serialization>" }`. Every `herdr-details` and error block therefore parses under oversize, multi-byte, cyclic, and hostile input, and states its truncation instead of implying it with a trailing marker. The same projection makes cycles, `bigint`, non-finite numbers, and non-JSON values safe, so serialization cannot throw. A typed failure keeps its `code` and bounded `message` unconditionally; only the evidence is bounded against what remains of the response budget.

Third, scheduling. The Pi host executes `herdr_communicate`, `herdr_pane`, and `herdr_tab` one at a time through `executionMode: "sequential"`; an MCP client can have many `tools/call` requests in flight, so `executionMode` is part of the host-agnostic definition projection and a session-scoped FIFO queue (`src/mcp/queue.ts`) serializes exactly those tools while every other tool stays concurrent. Argument validation happens before the queue, a failing call cannot poison it, a queued call whose request was cancelled is refused with `ABORTED` instead of executing, and shutdown closes the queue before the job registry and the transport so nothing mutates during teardown.

The host's process-execution capability enforces a documented 1 MiB per-stream ceiling while the pipes are still streaming, because `HerdrCli` bounds evidence only after a call settles. Crossing it kills the child with the same `SIGTERM`-then-`SIGKILL` escalation a timeout uses and rejects with `CLI_OUTPUT_OVERFLOW` and bounded evidence; nothing is collected after a call settles. Truncating a JSON protocol envelope and continuing would turn overflow into a parse error or a plausible-looking success.

The Pi `ExtensionContext` type is crossed at exactly one seam. The adapter builds a narrow host object with `cwd` and `signal`, wraps it in a Proxy that returns `undefined` for symbol keys and throws `HOST_CAPABILITY_UNAVAILABLE` for every other key, and casts that Proxy once. `modelRegistry` is denied along with everything else: the host injects a throwing `reviewerFactory`, so a `modelRegistry` read can only mean the reviewer seam was bypassed, and that must fail loudly rather than resolve to `undefined`. A unit test exercises all seven tools against a recording proxy to prove the read set is exactly `cwd` and `signal`.

Startup is fail-closed and ordered: `HERDR_ENV=1`; injected `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and `HERDR_PANE_ID` present and valid; `CLAUDE_PROJECT_DIR` present, absolute, and an existing directory. That directory is both the profile-discovery `projectCwd` and the operational `cwd`. There is no fallback to `process.cwd()`, the plugin root, or a module-relative path. Any failure exits non-zero before the transport connects, with no tool registered and no CLI call made. Herdr CLI compatibility stays a per-call preflight, unchanged from the Pi host.

Detached waits keep the in-memory job registry and are polled through `herdr_jobs`. The MCP host installs no terminal notification, no wait-job UI, no steering, and no turn injection, so the adapter never communicates with its own session. Ownership stays memory-only and scoped to the MCP process; shutdown marks jobs `shutdown` and resets the ledger without closing any Herdr resource.

Model-backed wait review remains a Pi capability. The MCP host injects a `reviewerFactory` that throws, so a detached wait job whose timeout exceeds the configured review cadence fails closed with `REVIEWER_FAILED`. The existing 1..30 minute `wait.reviewCadenceMinutes` setting is the only supervision knob; no unsupervised long wait is allowed. ADR-018 defines the detached-only wait API.

`@modelcontextprotocol/sdk` is the only new runtime dependency. The stdio entry lives at `src/mcp-server.ts` so typecheck, lint, and emit all cover it, and is compiled by `tsconfig.build.json` to `dist/src/mcp-server.js` because it runs under plain `node` without Pi's TypeScript loader. It carries no logic beyond an argument-free call into the run module, so it is the single `coverage.exclude` entry and is verified by the disposable-session integration run instead. No untyped root shim is introduced.

Because the server command resolves through `${CLAUDE_PLUGIN_ROOT}/..` into the installed repository, this slice supports local `--plugin-dir` loading only and marketplace publication is blocked.

## Alternatives considered

### Cut oversized structured blocks at a byte boundary and append a text marker

Rejected: the block stops being JSON exactly when it matters most, so a consumer parsing the evidence sees a syntax error instead of a truncated result, and the typed error object can be lost mid-serialization. A value-level envelope keeps the block parseable and makes the truncation explicit.

### Redact only inside the MCP adapter

Rejected as a report-specific fix. Only the `herdr-details` block would be covered, while a tool whose own content block serializes its details — `herdr_jobs`, whose job evidence embeds wait target metadata — would still publish an environment value in a shared text block. Redacting where a record enters evidence covers every block and both hosts; the boundary projection then guards anything added later.

### Serialize every MCP tool call

Rejected because read-only inspection, waiting, and job polling are safe to overlap and are the calls a manager makes most. Serializing them would make a long detached-wait poll block an unrelated inspect, which the Pi host never does.

### Truncate oversized subprocess output and continue

Rejected because a truncated JSON envelope is either a parse error attributed to the CLI or, worse, a partial object that looks like a valid result. A ceiling crossing is a host-level failure and must be reported as one.

### Write a separate Claude-side tool implementation

Rejected because duplicated schemas, resolution, bounds, and provenance would drift. Two implementations mean two safety models and two correct edits per policy change.

### Expose a raw-shell Herdr MCP tool

Rejected because it bypasses typed schemas, exact targeting, bounded evidence, ownership, and provenance, and it recreates the unconstrained surface the seven tools exist to replace.

### Model Claude as a native `.claude/agents` subagent

Rejected because the manager is the primary interactive session with owner presence and a visible Herdr pane identity. A native subagent is hidden delegation with no pane, no authoritative identity, and no provenance.

### Use the SDK's high-level `McpServer` registration API

Rejected for this slice because its ergonomic path expects Zod schemas, which would mean maintaining a second schema definition per tool or a schema converter. The low-level server accepts the existing JSON Schema directly.

### Publish `outputSchema` and `structuredContent`

Rejected for now. The `details` shapes are unions with many optional fields; a published schema would duplicate policy and could make a client reject otherwise valid authoritative evidence. Bounded JSON in a text block carries the same information without a second contract.

### Refactor the shared tools to accept a narrow host type instead of `ExtensionContext`

Rejected for this slice because narrowing a parameter on a typed function property is unsound under `strictFunctionTypes` and would spread churn across every tool module. One tested Proxy plus one cast localizes the risk and adds a runtime guarantee the type change would not provide.

### Trust `process.cwd()` for the project directory

Rejected because the subprocess working directory is chosen by the client, not the owner, and a wrong value silently changes profile discovery and the launch/pane/tab `cwd`. Requiring an absolute, existing `CLAUDE_PROJECT_DIR` makes the mistake visible at startup instead of at mutation time.

### Let the MCP host notify its own session when a detached wait finishes

Rejected because self-communication and automatic turn injection would make the adapter an actor in the manager's turn loop. Polling through `herdr_jobs` keeps the manager in control and keeps the evidence path authoritative.

### Allow `modelRegistry` to read as `undefined` on the MCP host

Rejected because the throwing `reviewerFactory` already covers the supported path. A tolerated `undefined` read would let a future code path construct a reviewer with no registry and fail deep inside a wait loop instead of at the boundary.

### Ship an untyped root shim as the executable entry

Rejected because a root file outside the existing `tsconfig.json` include and `eslint` inputs would be the one part of the server that no gate checks. Keeping the entry in `src/` costs one explicit coverage exclusion and buys typecheck, lint, and emit coverage.

### Make the package self-contained for marketplace installation now

Rejected for this slice. A cached marketplace install keeps only the package directory, so the server would need its own bundled build and dependency copy, which is a packaging redesign. Constraining the slice to local `--plugin-dir` loading and stating that publication is blocked is the smaller honest contract.

### Allow long waits without a reviewer on the MCP host

Rejected because it would silently drop the supervision the Pi host applies. Failing closed keeps the missing capability visible and leaves the cadence decision with the owner.

## Consequences

- A Claude Fable manager gets exactly the Pi manager's capabilities, evidence, and failure codes with no new policy surface.
- Every future tool or policy change lands once and reaches both hosts.
- The MCP host is deliberately weaker in two visible ways: no model-backed review beyond the configured cadence, and no push notification when a detached wait completes.
- Ownership and job state are per host process, so a server restart loses the ledger and leaves Herdr resources visible for explicit manual handling, exactly as ADR-001 specifies for the Pi runtime.
- An extra build step exists: the stdio entry must be compiled to `dist/src/mcp-server.js` before the manager session can load it.
- The package is usable only from its place in this repository via `--plugin-dir`; marketplace distribution stays blocked until a self-contained package is authorized.
- Any upstream change that makes a tool read a new host field breaks loudly in tests and at runtime instead of degrading quietly.
- Environment values never reach the model on either host, and the Pi TUI's expanded details no longer show them either, which is what the specification already required of tool output.
- Oversized evidence is published as a typed truncation envelope rather than a cut string, so a consumer that parses `herdr-details` keeps working and learns the original size.
- Two concurrent mutating calls from one manager session cost latency instead of interleaving; a client that fires them in parallel sees them complete in arrival order.
- A `herdr` invocation that floods a pipe fails that one call with `CLI_OUTPUT_OVERFLOW` instead of growing the MCP server's memory until the call settles.
- ADR-007's rejection of Herdr lifecycle tools for delegated Claude workers is unchanged; parity is granted only to the owner-started interactive manager session.
