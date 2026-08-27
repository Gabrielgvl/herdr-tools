# Spec: MCP caller context rebinding

## Status

Approved implementation slice.

## Objective

Keep Herdr MCP tools usable after Herdr moves the calling pane. The injected
`HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and `HERDR_PANE_ID` values remain required
bootstrap identity, but the injected tab and workspace are not treated as a
permanent topology snapshot.

## Contract

For every context-dependent tool call, resolve one effective caller context:

1. Require all three injected IDs to be present, non-empty, and single-line.
2. Read `herdr pane current --current` through the CLI adapter.
3. Require the live response to be a well-formed pane selected by
   `--current`. The selection is anchored by the injected pane identity, but a
   Herdr alias may return a new public pane ID. If the public ID changed, the
   live and snapshot records must both provide the same terminal identity.
4. Read `herdr api snapshot` and require exactly one matching effective pane,
   tab, and workspace with coherent parent relationships.
5. Use the live pane's tab and workspace IDs as the effective context.

A single bounded retry is allowed when the live read and snapshot disagree while
a pane move is in progress. Missing, malformed, duplicate, ambiguous,
unresolved, incoherent, replaced, or persistently racing topology fails with a
typed error. CLI and protocol failures remain failures. No focused-pane,
subprocess, label, or guessed-ID fallback is allowed.

The resolver returns the coherent snapshot with the effective IDs so target
resolution and the first operation read use the same view. All context-dependent
tool families use this shared resolver. Pane and tab tools do not retain their
old bootstrap-context assertions.

`herdr_inspect` with `mode: "context"` reports injected IDs, effective IDs, and
`rebound`. Other successful calls include a bounded `contextRebinding` block only
when the effective IDs differ from bootstrap IDs.

## Boundaries

- Startup still refuses any missing or malformed injected ID, `HERDR_ENV` other
  than `1`, or unusable `CLAUDE_PROJECT_DIR`.
- The resolver may rebind containing tab and workspace IDs for the same
  authoritative live pane selection. A changed public pane ID is accepted only
  through the successful `--current` alias path with terminal continuity.
- Ownership, sender provenance, self-target rejection, protected ancestors,
  explicit target checks, and post-state validation are unchanged.
- Health uses syntactic environment status and must not label stale ancestor IDs
  malformed. It does not bypass live context validation for context operations.

## Verification

Unit coverage must exercise same-tab moves, cross-workspace moves, unchanged
context, coherent retry, unresolved and duplicate callers, incoherent parents,
pane replacement, malformed/protocol reads, and every context-dependent tool
family. The disposable MCP integration reproduces split, move to a new tab, then
server startup with the original pane context IDs and verifies a successful
rebound context inspection.

Required commands are:

```bash
npm run test:unit
npm run typecheck
npm run lint
npm run build
npm run build:mcp
HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration -- --session herdr-tools-integration
```
