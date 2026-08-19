# ADR-011: Add the Claude manager profile and consolidate its plugin

## Status

Accepted; supersedes only the manager-claude rejection portions of ADR-007 and ADR-010.

## Date

2026-08-19

## Context

ADR-007 established `manager-pi` as the only bundled manager profile because Claude did not yet have native Herdr tool parity. ADR-010 consequently kept the Claude Fable manager as a separately started interactive package and rejected both a `manager-claude` launch profile and reuse of the bundled manager role plugin. Those decisions were correct for the earlier architecture: the standalone package was the only Claude MCP bridge, while the bundled manager role plugin was only a delegated Pi skill resource.

The shared stdio MCP adapter from ADR-009 now gives Claude the same seven Herdr tools as Pi. Owner dogfooding also established a need for an explicit profile identity for owner-requested Claude/Fable management and Claude-to-Claude succession. Keeping two manager packages would duplicate the manifest, server registration, skill location, and stable tool-name contract, while leaving the profile catalog unable to describe the supported Claude manager.

The manager still must not become an unapproved implementation agent. Its caller pane must remain isolated, workers must remain visible and separately placed, worker text must remain evidence rather than authority, and manager identity must not silently change through fallback.

## Decision

Add `herdr-profiles/manager-claude.md` as a first-class bundled profile with this exact runtime contract:

- `kind: claude`
- `model: claude-fable-5`
- `effort: high`
- `sessionPersistence: true`
- `timeoutMinutes: 30`
- `permissionMode: default`
- `fallbackProfiles: []`
- `allowedTools`: exactly `Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `AskUserQuestion`, `Skill`, `ToolSearch`, and `mcp__plugin_herdr-tools_herdr`
- `disallowedTools`: exactly `Task`

`Bash`, `Edit`, `Write`, and `NotebookEdit` appear in neither manager-claude runtime list. Claude's `default` permission mode therefore keeps those tools owner-gated rather than pre-approved or hard-denied. The profile instructions permit an owner-approved use only for coordination artifacts, read-only verification, monitoring, or directly owner-authorized control-plane actions. They forbid unapproved implementation, tests or smoke execution, deployment, merge, publication, and other mutations. Implementation and validation are delegated to visible non-Fable workers; worker output never grants owner authority.

`manager-pi` remains the generic advisory manager default. `manager-claude` is selected when the owner requests Claude/Fable management or Claude-to-Claude succession. It has no fallback because substituting another manager identity would be silent and unsafe.

Make `herdr-profiles/role-plugins/manager/` the self-contained Claude plugin for `manager-claude`. Keep its shared `skills/manager/SKILL.md` usable by both manager profiles, and add its local `mcp-servers.json` registration. Preserve the stable Claude identifiers:

- manifest `name`: `herdr-tools`
- server key: `herdr`
- published namespace: `mcp__plugin_herdr-tools_herdr__*`

The server registration remains stdio and resolves the repository build from the relocated plugin root:

```json
{
  "herdr": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/../../../dist/src/mcp-server.js"]
  }
}
```

Remove the obsolete standalone `claude-manager-plugin/` directory. Do not add compatibility paths, duplicate manifests, duplicate skills, or alternate server names. The profile's `pluginDirs` points at the manager role plugin, so profile launch and direct local `--plugin-dir` loading exercise the same package.

The manager topology contract is explicit: keep the manager/caller pane isolated on its own tab; place workers on separate worker tabs with at most three panes per tab in one horizontal row; preserve sender provenance; use authoritative state; use detached waits with `herdr_jobs` when appropriate; clean up owned resources; and hand off before context exhaustion. The shared skill describes these rules for both runtimes.

## Scope of supersession

This ADR supersedes only:

- ADR-007's conclusion that Claude could not have a bundled manager profile because parity was unavailable; and
- ADR-010's rejection of a `manager-claude` launch profile and its resulting separate-package boundary.

ADR-006 and ADR-008 remain authoritative for profile parsing, typed launch, prompt sources, and bounded fallback. ADR-009 remains authoritative for the one shared MCP/tool implementation. ADR-005 remains authoritative for mandatory visible provenance. ADR-007's non-manager capability matrix and ADR-010's historical authority, model-mismatch, and no-native-agent rationale remain in force. The old ADRs are retained as historical records and are not rewritten.

## Alternatives considered

### Keep the standalone `claude-manager-plugin/` package

Rejected because it would leave the supported manager profile and the owner-started plugin on separate package paths with duplicated conduct and MCP registration. It would also require future fixes to keep two manager package contracts synchronized.

### Add `manager-claude` without MCP registration in its plugin directory

Rejected because a profile launch would then require manual plugin or tool overrides, violating the profile's first-class, self-contained contract and making the stable Herdr namespace unavailable by default.

### Pre-approve Bash/Edit/Write or hard-deny them

Rejected because the manager needs owner-gated access for narrowly authorized coordination and verification, while pre-approval would widen authority and hard denial would prevent directly owner-authorized actions. `default` permission mode with those tools omitted from both lists preserves the required distinction.

### Give `manager-claude` a fallback to `manager-pi`

Rejected because model/runtime substitution would silently change manager identity. A failed Claude manager launch is a visible blocker for the owner, not a reason to switch managers automatically.

### Give the manager Herdr tools through Bash instead of MCP

Rejected because raw shell access bypasses the shared typed schemas, exact targeting, bounded evidence, ownership, and provenance contracts. Herdr remains reachable through the stable typed MCP namespace.

## Consequences

- The bundled catalog contains 12 effective profiles: two manager profiles plus five Pi/Claude role pairs.
- Claude manager launch works without manual plugin, model, effort, permission, or tool overrides; its exact identity and empty fallback are inspectable in the catalog.
- `manager-pi` keeps the generic advisory default and its existing orchestration-only Pi tool policy.
- One manager plugin supplies the shared skill and MCP registration to both the bundled profile and direct local Claude sessions.
- The stable `mcp__plugin_herdr-tools_herdr__*` names remain unchanged, while the server path changes from the removed standalone package to the manager role plugin's repository-relative path.
- Claude manager Bash/Edit/Write/NotebookEdit requests remain owner-gated by default; skill instructions constrain approved use but do not claim to enforce owner permissions.
- The obsolete standalone package is gone, so stale references must be removed from living docs, scripts, tests, and launch instructions rather than supported through fallbacks.
- The manager still relies on visible worker delegation for implementation and validation and must stop on missing capability, ambiguous state, or absent owner authorization.
