# ADR-008: Make Herdr launch profile-only with bounded fallback

## Status

Accepted; partially supersedes ADR-006

## Date

2026-08-10

## Context

ADR-006 established profile-backed delegation as the first layer, but its interim launch surface still permitted raw Herdr agent kinds and arguments and deliberately deferred automatic fallback. That surface made it possible to bypass typed runtime, permission, prompt-source, and capability policy. The new launch contract must keep visible Herdr lifecycle ownership while making profile selection mandatory.

Herdr startup can report a precise machine error when a process exits before becoming interactive. That error is safe to retry only when a fresh authoritative pane read proves that no agent remains. Other failures may represent a live process, a protocol mismatch, a timeout, an identity mismatch, a prompt failure, or an uncertain mutation and must not be guessed into a fallback.

## Decision

`herdr_launch` exposes strict named Pi/Claude profiles only. The public request contains `name`, required `profile`, typed `overrides`, placement fields, and optional initial prompt fields. Raw `kind`, `argv`, and `env` launch fields are rejected. Profile discovery remains rooted at the manager session cwd and arbitrary valid profiles remain selectable.

A launch resolves a deterministic reachable profile order with a maximum of three attempts. Typed overrides apply only to the requested primary profile. Fallback profiles use their untouched defaults, including runtime, model, prompt source, timeout, and permissions. Automatic fallback is allowed only for the exact machine-typed Herdr error code `agent_start_failed` with message `process exited before becoming interactive`, followed by an authoritative pane read proving the pane has no agent. Every timeout, malformed/protocol, identity/kind, prompt, or uncertain-state failure stops. Exhausted chains stop and report bounded attempt evidence; no profile is improvised.

Launch details report requested and selected profiles, effective runtime/model/source/timeout/permissions, bounded attempts, authoritative IDs/post-state, and visible assignment provenance. Profile sources are prepared before topology mutation. Herdr core, installed extensions, durable receipts, launch metadata, quarantine, configuration toggles, and communication restrictions are unchanged.

This ADR partially supersedes ADR-006 only for the launch input and bounded fallback behavior. ADR-006's profile ownership, prompt-source, provenance, layered runtime prerequisites, and later structured delegation decisions remain in force.

## Alternatives considered

### Keep raw kind/argv/env as an additional mode

Rejected because it bypasses the strict profile contract and creates two launch semantics with different safety and evidence guarantees.

### Retry every startup failure

Rejected because timeout, protocol, identity, prompt, and uncertain failures do not prove that retrying is safe and could create duplicate or uncontrolled agents.

### Select a fallback from role heuristics after exhaustion

Rejected because fallback order must come from the validated profile graph. Manager improvisation would hide configuration errors and make launch behavior nondeterministic.

### Apply primary overrides to every attempt

Rejected because a fallback profile's own runtime, permissions, and model are its contract; leaking overrides would change the meaning of the fallback.

## Consequences

- Every successful `herdr_launch` has a named profile and typed runtime evidence.
- Existing placement modes, initial-prompt provenance, and unrestricted `herdr_communicate` behavior remain unchanged.
- Safe pre-interactive process exits can recover in the same pane without inventing a profile.
- Failures remain visible with bounded attempt evidence and retained created resources.
- Callers that previously supplied raw launch fields must choose a profile; no compatibility parser is provided.
