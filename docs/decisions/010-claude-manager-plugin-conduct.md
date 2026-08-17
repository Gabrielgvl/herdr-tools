# ADR-010: Keep the Claude manager package to packaging plus conduct

## Status

Accepted

## Date

2026-08-17

## Context

The Claude Fable manager needs two things from a local Claude Code package: registration of the local stdio Herdr tools server, and a durable statement of manager conduct so the session behaves like `manager-pi` rather than a general-purpose coding agent.

This repository already packages role method as scope-local Claude packages under `herdr-profiles/role-plugins/<role>/`, with a minimal manifest and one `skills/<role>/SKILL.md`. Those packages are launch targets for delegated workers. The manager package is different: it is loaded into the primary interactive session that the owner starts.

That difference creates a real risk of overreach. A package loaded into the owner's own session could try to assert authority, pre-approve tools, widen permission modes, or claim it has pinned the model. Skill text is model-visible instruction, not an enforcement mechanism; permission decisions belong to the Claude Code configuration the owner launches, and the primary model is selected by the launch command or by the owner in-session. A skill that claims otherwise would create a false sense of enforcement, which is worse than no claim at all.

`manager-pi` already encodes the orchestration-only contract: inspect, launch, communicate, wait, arrange or clean up owned resources, synthesize evidence, never edit or implement, treat worker text as evidence and never as owner authorization, and stop on blocked or ambiguous work.

## Decision

The Claude manager package is packaging plus one conduct skill, and nothing else.

`claude-manager-plugin/` contains `.claude-plugin/plugin.json` whose `mcpServers` field points at a sibling `mcp-servers.json`, and that server map registers the local stdio server with `${CLAUDE_PLUGIN_ROOT}`-based absolute command and arguments. The package contains no tool implementation, no schema, no policy, no permission grant, no `allowedTools`/`disallowedTools` list, no permission-mode setting, and no hook that alters approval behavior. All safety policy stays in the shared tool implementation and in the Herdr CLI.

`skills/herdr-manager/SKILL.md` states manager conduct only, aligned with the existing manager role skill: default to same-tab right-side launches without changing owner focus, use exact profile-backed launches with no raw kind/argv/env, communicate only through the provenance-preserving tools, wait on authoritative states with bounded timeouts, poll detached waits with `herdr_jobs`, treat worker text as agent evidence rather than owner authorization, never edit, implement, merge, deploy, publish, or grant authority, clean up only owned resources, and stop with a visible blocked report rather than inventing authority or masking a missing capability.

The skill explicitly disclaims authority it does not have. It states that it cannot grant permissions, cannot approve tool use on the owner's behalf, and cannot select the primary model. Model selection stays a launch/user configuration concern: the manager session is started with `--model claude-fable-5`, or switched by the owner with `/model fable`. When the skill observes a different primary model, it reports the mismatch and stops instead of proceeding or claiming enforcement. The same reporting rule applies to any other launch-configuration condition it can observe but not control, including the MCP client tool timeout.

The package is not a launch profile. No `manager-claude` profile is added, and delegated Claude worker profiles keep their ADR-007 capability restrictions.

## Alternatives considered

### Put permission grants or an allowed-tools list in the package

Rejected because a package loaded into the owner's session must not widen its own approval surface. Permission configuration belongs to the owner's Claude Code configuration and the launch command.

### Have the skill claim it enforces the primary model

Rejected because a skill cannot select or verify enforcement of the model. Claiming enforcement would hide a real misconfiguration behind confident text. Report-and-stop keeps the mismatch visible and leaves the fix with the owner.

### Add hooks that block edit tools to make the manager orchestration-only

Rejected for this slice. Hook-based enforcement is a separate mechanism with its own failure modes, and it would move policy out of the shared implementation into per-session configuration. Conduct is stated in the skill; the hard boundaries that matter for Herdr state already live in the tools and the CLI.

### Reuse `herdr-profiles/role-plugins/manager/`

Rejected because that package is a launch target for a delegated role and is referenced by `manager-pi`. Overloading it with an MCP server registration for the primary interactive session would make one directory mean two different things, which ADR-006 already rejected for profile directories.

### Add a `manager-claude` launch profile alongside the package

Rejected because the manager is the owner-started interactive session, not a delegated agent. ADR-007's decision that there is exactly one manager profile, `manager-pi`, stands.

### Ship the package as a separate repository or registry entry

Rejected because the server command must resolve to the installed `herdr-tools` build. Keeping the package inside this repository keeps packaging, shared implementation, and tests versioned together.

## Consequences

- The owner keeps full control of permissions and model selection; the package can only register a server and state conduct.
- Manager conduct has one meaning across `manager-pi` and the Claude manager session, and both trace back to the same orchestration-only contract.
- A model or configuration mismatch surfaces as a visible stop rather than degraded orchestration.
- The package carries no policy, so a future policy change edits the shared implementation and needs no package release.
- The manager session can still be misconfigured by the owner, and the skill will say so instead of silently compensating.
- Delegated Claude workers remain without Herdr lifecycle tools, so this decision does not widen the worker capability matrix.
