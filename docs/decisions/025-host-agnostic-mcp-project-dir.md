# ADR-025: Host-agnostic MCP project-directory resolution

## Status

Accepted. Supersedes the `CLAUDE_PROJECT_DIR` gating contract in
`docs/specs/claude-fable-manager-mcp.md` (Phase 4) and the refusal-reason name
in `src/mcp/host.ts`. There is no backward-compatible alias: `CLAUDE_PROJECT_DIR`
is no longer read anywhere.

## Context

The stdio MCP server resolved its session project directory exclusively from
`CLAUDE_PROJECT_DIR`, an environment variable only Claude Code exports to MCP
subprocesses. Registering the same server on another host (Devin CLI) forced a
static `env` value in the client config, which mis-anchored every session to one
fixed directory regardless of that session's actual workspace — observed live on
this installation, where a Devin session in an unrelated workspace inherited a
foreign project directory.

`/proc` inspection of running servers showed every observed MCP host (Claude
Code plugin subprocesses and Devin stdio servers alike) already spawns the
server with its process cwd set to the session's project directory.

## Decision

`resolveStartup` resolves the project directory host-agnostically:

1. `HERDR_PROJECT_DIR`, when set, is the explicit override and must validate.
   A set-but-invalid value refuses startup; it never falls through to the
   launch directory, so a misconfiguration fails loud instead of silently
   re-anchoring.
2. When unset, the server's own launch directory (`process.cwd()`, injectable
   as `deps.cwd`) anchors the session.

Both sources must be absolute, single-line, below the filesystem root, and an
existing directory. The refusal reason is renamed `PROJECT_DIR`; the gate stays
fail-closed, ordered after `HERDR_ENV` and injected-identity checks, and still
never echoes values.

`run.ts` exposes the `cwd` dependency for hermetic tests. No registration
carries `env` for the project directory anymore: the Claude plugin's
`mcp-servers.json` already shipped without one, and the Devin user-scope
registration drops its temporary static `CLAUDE_PROJECT_DIR` mapping.

## Consequences

- The same unmodified `mcpServers` stanza (`command` + `args` only) now works
  on any host that launches stdio servers from the workspace — verified for
  Claude Code and Devin CLI.
- The project-dir refusal is narrower than before: it fires on an explicit bad
  `HERDR_PROJECT_DIR`, a degenerate launch directory (filesystem root,
  deleted cwd, non-directory), and nothing else. The trust boundary is
  unchanged — `HERDR_ENV` plus injected workspace/tab/pane identity still gate
  every session.
- A host that launches stdio servers from a directory unrelated to the session
  workspace would anchor incorrectly instead of refusing; no such host is
  known, and `HERDR_PROJECT_DIR` remains the override if one appears. MCP
  `roots/list` was considered and rejected: Devin does not advertise the
  capability, and post-`initialize` root resolution would force lazy
  project-dir wiring through the tool surface for no observed benefit.
- The `claude/channel` experimental capability advertisement is unchanged: it
  is a namespaced wire capability hosts ignore when unsupported, not a config
  coupling.
