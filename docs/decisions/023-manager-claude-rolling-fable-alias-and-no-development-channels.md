# ADR-023: Pin `manager-claude` to the rolling `fable` alias and drop its development-channel opt-in

## Status

Accepted; supersedes the `model: claude-fable-5` clause of ADR-011's exact runtime contract,
the `manager-claude` channel opt-in recorded in ADR-019, and ADR-019's claim that every
supervision event is recoverable through `herdr_jobs get`. Every other clause of both ADRs stands.

## Date

2026-09-08

## Context

ADR-011 fixed `manager-claude` to the exact model ID `claude-fable-5`. Claude Code also
accepts a rolling alias: `--model` documents "an alias for the latest model (e.g. 'fable',
'opus', or 'sonnet') or a model's full name". A pinned ID therefore freezes the manager on one
Fable release and needs a profile edit, a docs edit, a test edit, and a bundle repin every time
a newer Fable ships, while the owner's intent has consistently been "the latest Fable".

ADR-019 additionally had `manager-claude` opt into the Claude Code Channels research preview
with `runtime.developmentChannels: ["server:herdr"]`, emitted as
`--dangerously-load-development-channels server:herdr`, so supervisor wakes could be pushed
inbound. End-to-end channel delivery was never proven: it also requires the organization's
`channelsEnabled` managed setting, which this repository can neither set nor observe. In
practice the unproven opt-in produced two startup warnings on every manager launch — an
organization-policy warning and a missing-MCP-server warning — for a delivery path that never
demonstrably delivered.

## Decision

1. `manager-claude` declares `model: fable`. The rolling alias resolves to the latest supported
   Fable model at launch, so the exact model ID varies over time and no specific ID is expected
   or asserted anywhere. `planner-claude` keeps its pinned `claude-fable-5`; this decision is
   scoped to the manager identity.
2. `manager-claude` declares no `runtime.developmentChannels`. No
   `--dangerously-load-development-channels` opt-in is emitted, and neither startup warning is
   raised. Generic `developmentChannels` support stays in the profile parser and the Claude
   adapter, and remains profile-only, so any other profile may still opt in.
3. Claude manager supervision wakes are recovered by polling `herdr_jobs`. That recovery is
   bounded, not lossless: the supervision event log is a ring that keeps the newest entries,
   `herdr_jobs get` returns only the retained pending events and marks exactly those observed,
   and `truncatedEvents` is a cumulative count of ring evictions plus entries omitted from a
   projection. It reports only that retained history is incomplete and says nothing about whether
   the missing entries had been observed, so managers must not infer a lost or delivered receipt
   from it. They poll frequently so pending receipts are collected while still retained, and
   reconcile authoritative current state when the missing history matters.

## Consequences

- The manager tracks new Fable releases with no repository change, and no test or document
  asserts a Fable model ID for `manager-claude`.
- The alias is resolved by Claude Code, not by this extension, so the running model is
  observable only from the session itself. The manager role skill keeps its report-and-stop
  rule for an unexpected model and still claims no enforcement.
- Manager launches are quiet: no channel flag, no policy warning, no missing-server warning.
- Losing the inbound path makes poll cadence load-bearing. A manager that polls slower than the
  ring evicts can lose the chance to collect a pending receipt, which is why the bounded contract
  is stated in the profile body,
  both manager skill copies, `README.md`, `SPEC.md`, and the supervision spec rather than left
  implicit.
