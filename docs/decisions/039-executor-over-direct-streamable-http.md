# ADR-039: Executor over direct Streamable HTTP

## Status

**Accepted** (2026-10-01). Phase 1 is static configuration only: the plugin
registration, the sync timer units, prepared host diffs, and this record. The
stdio proxy script and its tests stay in the tree as the fallback; stripping
them is the separate phase-2 change. Owner rulings applied: one env var
(`MCP_EXECUTOR_API_KEY`, exported host-wide from `~/.hermes/.env`) referenced
as a placeholder in every registration — launch-time token injection
(assignment A9.3) is not built; the loopback toolkit URL is used for every
same-host registration.

## Date

2026-10-01

## Context

Every agent session spawned `executor-project-mcp.mjs`, a Node process that
synced the `coding-agents` toolkit's connection list once and then bridged
stdio to Executor's Streamable-HTTP endpoint. Measured 2026-10-01: 45–48
processes at 1.5–1.6 GiB RSS plus swap at normal load, worse at peak lanes —
one process per session for a function every harness already implements
natively. The proxy also connects upstream once and survives an Executor
restart only through its own lazy-reconnect wrapper, while the harnesses'
native HTTP clients already reconnect correctly. The full evidence and the
measured host facts are in the RAM design note
(`ht-design.md` §A); this ADR records the decision and its trade-offs.

## Decision

- **Endpoint.** Every harness registers `executor` as a Streamable-HTTP server
  at `http://127.0.0.1:4788/mcp/toolkits/coding-agents?artifacts=false`.
  Loopback, not the `ts.net` name: no TLS, no `tailscaled` dependency, no
  extra hop for same-host lanes (the ts.net URL remains for off-host callers).
  The toolkit-scoped URL keeps `hindsight` and `hindsight-bank-*` connections
  out of the agents' Executor surface, and `artifacts=false` withholds the
  artifact surface — the two things the proxy's per-spawn setup actually
  guaranteed; the toolkit is global, so no per-project scoping is lost.
  The server name stays `executor` everywhere so published tool names
  (`mcp__plugin_herdr-executor_executor__*`, `mcp__executor__*`) and the
  catalog/compile grants are unchanged.
- **Auth placement.** The token lives only in `~/.hermes/.env` (mode 600).
  Every registration references the `${MCP_EXECUTOR_API_KEY}` placeholder —
  the Claude plugin map and Claude user scope use `"Authorization": "Bearer
  ${MCP_EXECUTOR_API_KEY}"`; pi uses the same `${NAME}` header syntax; Devin
  uses its `${env:MCP_EXECUTOR_API_KEY}` secrets syntax; codex uses
  `bearer_token_env_var = "MCP_EXECUTOR_API_KEY"`; hermes already interpolates
  `${MCP_EXECUTOR_API_KEY}` from its own `.env`. No herdr-tools code reads or
  forwards the token. Stated trade-off: the token is in the agent process
  environment, which an agent could print — the same exposure as today's
  readable `~/.hermes/.env`; the delta is accidental disclosure, mitigated by
  rotation and, if Executor supports it, a toolkit-scoped key (open question).
- **Sync relocation.** The toolkit membership sync moves from per-session
  spawn to `herdr-tools-executor-sync.timer` (`OnCalendar=*:0/10`,
  `Persistent=true`), a oneshot running the existing
  `executor-project-mcp.mjs --sync` under the real Node binary (not the Volta
  shim — see `deploy/executor/herdr-mcp-integration.json`). No
  `EnvironmentFile`: the script loads the token from `~/.hermes/.env` itself.
  A ten-minute lag on connection-set changes is acceptable; the sync is
  idempotent and prints one JSON line per run.
- **Rollout is config-only.** The plugin `mcp-servers.json` ships in the repo;
  the four user-scope harness configs and hermes ship as prepared diffs in
  `deploy/executor/` with the pre-change registrations kept beside them
  (`executor-original-*`). Running sessions keep their proxy until they
  restart; the owner enables the timer and applies the diffs separately.

## Alternatives considered

- **`executor mcp` per session**: still one process per lane, and the
  bun-compiled binary is heavier than the node proxy. Rejected.
- **One shared stdio multiplexer**: stdio is one-to-one; a mux is the
  ADR-0004 relay shape, which exists for the governor's own tools and is
  unnecessary where every harness already has an HTTP client. Rejected.
- **OAuth (`mcp login`)**: Executor exposes no OAuth discovery endpoints.
  Rejected.
- **Unix socket / ts.net for same-host lanes**: no socket listener exists;
  ts.net works but adds TLS and a `tailscaled` dependency for nothing same-
  host. Rejected for same-host; kept for off-host callers.
- **Keep the proxy with a reconnect fix**: retains the ~1.5 GiB process floor.
  Retained only as the per-harness fallback if a harness's HTTP path fails.
- **Launch-time token injection (design A6a)**: owner ruling replaced it with
  the host-wide env export, so no `src/tools/launch.ts` change is built.
- **Shell/user-wide static token copies**: rejected; the single env var keeps
  one rotation point.
- **Per-project toolkits or a project header**: Executor toolkits filter per
  user, not per project; there is no per-project state to preserve. Rejected.

## Consequences

- New Claude lanes connect directly; the per-session Node proxy and its Volta
  shim disappear from the process table as lanes restart. Target measured by
  the §A11 census: zero proxy processes for new lanes.
- **Devin header interpolation is the unverified edge**: `${env:…}` expansion
  is documented only for OAuth fields (the binary's MCP importer also
  understands `${file:}` and `${VAR}`/`${VAR:-default}`), so if a live Devin
  session 401s after the diff is applied, the fallback is a static header in
  the mode-600 `~/.config/devin/mcp_config.json`. The precedence drill showed
  Devin's own config wins over the imported `~/.claude.json` entry, so the
  two files can disagree during rollout without shadowing.
- An Executor daemon restart previously stranded every proxied session;
  direct clients reconnect per their own policies (verified for the proxy
  shape by `test/unit/executor-project-mcp.test.ts`; native-client restart
  drills remain owner-side).
- Rollback is `patch -R` on any applied diff (or restore from
  `executor-original-*`), `git revert` of the plugin map (autoupdate
  redeploys), and disabling the timer — each independently safe.
- Phase 2, gated on a clean soak: strip the proxy half of
  `executor-project-mcp.mjs`, rename it `executor-toolkit-sync.mjs`, and
  update the timer path and `test/unit/executor-project-mcp.test.ts`.
