# ADR-006: Layer profile-backed delegation over Herdr panes

## Status

Accepted

## Date

2026-08-08

## Context

`pi-subagents` runs hidden child processes and owns profile discovery, prompt assembly, chains, artifacts, forked context, and result capture. Herdr already owns visible pane topology, agent startup, status, exact targeting, and inter-agent provenance. Maintaining both delegation systems creates duplicated orchestration and prevents pane-native inspection and recovery.

A direct feature-parity rewrite would mix profile parsing, agent-specific configuration, terminal lifecycle, durable results, retries, and workflow chains in one release. Current Herdr status and terminal output are not sufficient to claim an authoritative final assistant result or safe provider-failure fallback.

## Decision

Build the replacement in layers.

`herdr-tools` owns separate bundled/user/project profile files and strict resolution. Profiles pin Pi or Claude, use typed runtime blocks, append a required Markdown body to the default system prompt, and never expose raw argv or arbitrary environment overrides.

The first slice adds the profile catalog, inspection, adapters, and profile-backed launch using existing Herdr primitives. It exposes fallback metadata but does not automate fallback or scrape terminal output as a result.

Herdr core subsequently gains stdin prompt transport, structured turn results, cancellation, same-pane replacement, durable lineage, and result/transcript references. Only then does `herdr-tools` add the blocking `herdr_delegate` state machine.

`pi-subagents` remains available during development and is removed after the complete replacement passes acceptance gates. No legacy profile parser or compatibility path is added.

## Alternatives considered

### Rebuild all `pi-subagents` features immediately

Rejected because chains, artifacts, forked context, worktrees, and detached orchestration are not required for the common delegation path and would delay a working end-to-end slice.

### Keep profiles in Herdr core

Rejected for now because Pi/Claude model, tools, plugins, skills, and permission fields are client-specific. Herdr remains authoritative for process and pane lifecycle; `herdr-tools` owns behavioral configuration.

### Reuse existing `~/.pi/agent/agents` files

Rejected because those files have a legacy flat parser and `pi-subagents` semantics. Sharing the directory would make one file mean different things to two extensions.

### Use raw argv profiles

Rejected because arbitrary flags bypass typed prompt, permission, lifecycle, and validation contracts.

### Implement fallback by transcript matching

Rejected because provider text changes and classification errors can hide authentication, configuration, or correctness failures.

## Consequences

- Users get a dogfoodable profile layer before the full replacement is complete.
- The public surface remains honest: Slice 1 launches profile-backed agents but does not promise structured results or automatic fallback.
- The complete feature spans this TypeScript extension and the Rust Herdr runtime/integrations.
- Profile configuration is deliberately powerful: typed call overrides may expand capabilities, Claude bypass modes are allowed, and project profiles have no trust gate.
- The runtime requires durable evidence and lineage for indefinitely suspended runs; active/suspended evidence is not constrained by the terminal 100 MiB retention cap.
- Architectural complexity is introduced only when its prerequisite layer works and is tested.
