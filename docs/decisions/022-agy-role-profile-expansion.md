# ADR-022: Expand AGY role profiles with fixed modes

## Status

Accepted

## Date

2026-09-02

## Context

Herdr Tools already supports a reduced-assurance AGY researcher without changing
Herdr Core. Reconnaissance and implementation need the same Tools-only path, but
AGY's permission and mode flags must remain explicit profile policy rather than
caller-controlled launch options.

## Decision

Add strict AGY runtime frontmatter `mode`, accepting only `plan` and
`accept-edits`. The mode is required, fixed by the selected profile, and cannot
be overridden at launch. `researcher-agy` and `scout-agy` use `plan`; `worker-agy`
uses `accept-edits`. The bundled chains are:

```text
scout-agy -> scout-pi -> scout-claude
researcher-agy -> researcher-pi -> researcher-claude
worker-pi -> worker-agy -> worker-claude
```

AGY argv retains the live-validated harmless bootstrap as its final startup
input: `--prompt-interactive "Initialize this interactive session and reply with
exactly AGY_READY."`. The real task remains one self-contained, visible,
provenance-wrapped v1 stdin assignment; no profile body is delivered to AGY.
Inspection and launch details report the actual fixed mode and
`dangerouslySkipPermissions: true`.

## Consequences and risk

The worker profile combines `accept-edits` with
`--dangerously-skip-permissions`, so AGY can auto-approve repository mutations.
Manager assignments must therefore bound the mutation scope and required tests.
All fallback and bootstrap behavior remains in Herdr Tools; Herdr Core is
unchanged.
