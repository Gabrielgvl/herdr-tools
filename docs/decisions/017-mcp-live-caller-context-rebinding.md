# ADR-017: Rebind MCP caller context from the live pane

## Status

Accepted

## Date

2026-08-27

## Context

Herdr injects workspace, tab, and pane IDs into an agent process when the pane
starts. Herdr can later move that pane to another tab or workspace. The terminal
kept the original `HERDR_TAB_ID` and `HERDR_WORKSPACE_ID`, even though the pane
ID still identified the live caller. The MCP host treated all three values as an
immutable topology snapshot and rejected every call when the old ancestors no
longer contained the pane.

The caller identity boundary must survive valid pane moves without accepting a
replacement pane or an incoherent topology. A resolver also needs to give every
tool one coherent view. Re-reading only the old injected IDs, trusting UI focus,
or adding a fallback based on labels would either keep the outage or target the
wrong resource.

## Decision

Keep all three injected IDs as required syntactic bootstrap identity at startup.
Do not validate their ancestor relationships against the first snapshot and do
not change startup to perform a live CLI read.

Every context-dependent tool invocation uses one shared effective-context
resolver. The resolver performs these reads in order:

1. `herdr pane current --current` through the existing CLI adapter.
2. `herdr api snapshot`.

The live result must be a well-formed pane selected by `--current`. That
selection is anchored by the injected pane identity, but an old Herdr alias may
return a new public `pane_id`. The resolver then requires exactly one matching
effective pane, tab, and workspace in the snapshot. The pane's tab and workspace
fields must agree with the live current result, and the tab and workspace parent
relationship must be coherent. When the public pane ID changed, both records must
also provide the same terminal identity. The live tab and workspace IDs become
the effective context. A terminal mismatch, an unprovable changed-ID continuity,
or any malformed identity fails closed.

If the live current result and snapshot disagree in a way consistent with a
concurrent move, the resolver makes one additional complete current-plus-
snapshot attempt. It never merges records across attempts. Unresolved or
persistently racing topology returns `CONTEXT_UNAVAILABLE`; CLI and protocol
errors retain their own typed failures. Duplicate caller records, duplicate
containing ancestors, missing parents, incoherent relationships, and replacement
uncertainty fail closed.

The resolver returns the accepted snapshot, effective IDs, operation IDs, and
bounded diagnostics. `herdr_inspect` with `mode: "context"` always reports
`context.injected`, `context.effective`, `context.rebound`, and the attempt count.
Other successful context-dependent tools report `contextRebinding` only when a
rebind occurred. This keeps normal results compact while making a repair visible.

The shared Pi and MCP tool surface constructs one resolver and passes it to every
context-dependent tool. Pane and tab tools remove their duplicate strict checks
against the bootstrap context. Pure target resolution remains strict when given
an already resolved context, and no caller identity or safety boundary is
weakened.

## Alternatives considered

### Trust the injected tab and workspace IDs forever

Rejected. A pane move leaves the pane usable while invalidating its injected
ancestors. This is the outage that prompted the change.

### Trust `pane current --current` without a snapshot

Rejected. A current response alone does not prove that its tab and workspace
records exist uniquely or that their parent relationship is coherent.

### Search the snapshot for the injected pane ID without a live current read

Rejected. It cannot follow an old alias to a new public pane ID, distinguish a
stable caller from replacement or duplicate pane records, or establish that the
CLI's current alias resolves to the same pane.

### Fall back to the focused pane, a label, or a matching process

Rejected. Focus and display metadata are not caller identity. A fallback could
silently send a message or mutation to another agent.

### Re-read until the topology looks coherent without a fixed bound

Rejected. An unbounded retry could hang a tool and hide a continuously changing
or adversarial topology. One bounded retry covers the known move race and keeps
failure visible.

### Resolve context separately in every tool module

Rejected. Duplicated read order and validation would drift across inspect,
communication, waits, launch, and topology mutations. One resolver keeps the
identity boundary identical for both hosts.

## Consequences

- Pane moves within a workspace and across workspaces remain usable when the
  original pane ID still resolves authoritatively.
- Startup remains fail-closed for missing or malformed IDs and does not add a
  startup CLI dependency.
- Every context-dependent call pays one live current-pane read and one snapshot
  read, with one bounded retry only for a coherent concurrent-move race.
- A fast move, duplicate record, replacement, protocol failure, or incoherent
  parent relationship produces a visible failure instead of a guessed target.
- Effective context diagnostics make stale-ancestor repair observable without
  adding a full topology snapshot to every result.
- Sender provenance, self-target rejection, ownership, protected ancestors,
  explicit-target safety, and mutation post-state contracts are unchanged.
