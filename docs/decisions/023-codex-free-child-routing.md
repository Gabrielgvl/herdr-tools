# ADR-023: Make manager child routing Codex-free by default

## Status

Accepted; supersedes ADR-022's `worker-pi`-first routing decision.

## Date

2026-09-04

## Context

Manager sessions launched Pi child workers for routine exploration, implementation,
review, and promotion. Those children consumed the owner's Codex quota even though
AGY and Claude role profiles were already available. Profile fallback order alone did
not help because a healthy `worker-pi` never reached `worker-agy`.

## Decision

Keep `manager-pi` as the generic manager, but make its child routing Codex-free by
default:

```text
explore: scout-agy
research: researcher-agy
plan: planner-claude
work: worker-agy -> worker-claude
critic: reviewer-claude
promote: promoter-claude
```

A manager may launch a `*-pi` child only when the owner explicitly requests Pi or
Codex for that child. AGY assignments remain self-contained, provenance-wrapped, and
bounded because profile Markdown is not delivered to AGY and `worker-agy` runs in
`accept-edits` mode.

## Consequences

Routine child work no longer consumes Codex quota. The manager itself may still use
Codex when launched as `manager-pi`. Roles without AGY profiles use Claude. Existing
Pi profiles remain available for explicit owner-directed use and are not compatibility
fallbacks for the default worker path.
