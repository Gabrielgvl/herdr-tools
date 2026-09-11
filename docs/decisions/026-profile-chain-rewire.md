# ADR-026: Profile fallback-chain rewire and Devin lane expansion

## Status

Accepted. Supersedes every fallback-chain pin in the living prose: the role
chains and defaults paragraphs in `docs/specs/profile-backed-delegation.md`,
`docs/specs/manager-profile-capabilities.md`, `docs/specs/agy-runtime-support.md`,
`docs/specs/large-agent-communications.md`, `SPEC.md`, `README.md`,
`herdr-profiles/manager-claude.md`, and the `manager`/`harness-flow` skills.
ADRs 006/007/008/021/022 keep their historical chains as decided at the time.
This ADR records the chain order only; the MCP project-directory gate is
ADR-025's and the fallback *trigger* contract is unchanged.

## Context

The bundled catalog grew a Devin lane for every role and the owner re-specified
each role's fallback order. Five profiles are new: `manager-devin`,
`planner-devin`, `promoter-devin`, `researcher-devin`, and `scout-devin`
(joining the existing `worker-devin` and `reviewer-devin`), each pinning
`kind: devin`, `model: swe-2-max`, `permissionMode: dangerous`, and
`sessionPersistence: true`. The bundled catalog is now 24 profiles.

The previous chains left the managers with no fallback at all, ran the
implementation chain through `worker-agy`, and capped resolution at three
attempts — too shallow for the new four-deep scout and researcher chains.

## Decision

The declared bundled chains are now exactly:

- manager: `manager-claude -> manager-pi -> manager-devin`
- planner: `planner-pi -> planner-claude -> planner-devin`
- scout: `scout-agy -> scout-claude -> scout-devin -> scout-pi`
- researcher: `researcher-agy -> researcher-claude -> researcher-devin -> researcher-pi`
- worker: `worker-devin -> worker-pi -> worker-claude`
- reviewer: `reviewer-devin -> reviewer-pi -> reviewer-claude`
- promoter: `promoter-devin -> promoter-claude -> promoter-pi`

`worker-agy` is no longer on the default implementation chain; it remains
directly selectable and still falls back to `worker-claude`. `worker-pi` is now
on the default chain rather than a side selection. The `harness-flow` promote
phase launches `promoter-devin`, the promoter chain head.

`promoter-devin` joins `promoter-pi` and `promoter-claude` in
`RESERVED_BUNDLED_PROFILE_NAMES`, so all three promoter names always resolve
from the bundled catalog and reject runtime overrides; the delivery-authority
trust boundary covers the whole chain, not just its old head.

`resolveProfile`'s `maxAttempts` default rises from 3 to 4, required by the
four-deep scout and researcher chains. The attempt bound applies to the whole
reachable graph, so a chain deeper than the cap still fails validation closed
rather than truncating silently.

Two profile policy changes rode along with the rewire: `manager-pi` thinking
rose from `low` to `xhigh`, and `worker-claude` moved from `acceptEdits` to
`dontAsk` permission mode, matching every other bundled Claude role profile.

## Consequences

- Every bundled role now has Pi, Claude, and Devin lanes (plus the AGY lane on
  scout, researcher, and worker), and every role chain terminates on a
  different runtime than it starts — a provider or CLI failure on one runtime
  no longer exhausts a role.
- Manager fallback now exists: `manager-claude` can fall back to `manager-pi`
  and then `manager-devin`, but only through the unchanged exact
  pre-interactive `agent_start_failed` plus no-agent proof. The old "no
  fallback because manager identity must not silently change" rationale is
  retired; identity still cannot change after any possible prompt effect.
- `promoter-devin` is a new delivery-authority entry point; reserving it keeps
  user and project profiles from substituting an untrusted promoter at the
  chain head.
- `maxAttempts: 4` widens the worst case for graph validation and launch
  preflight — every reachable fallback profile is still validated before the
  first launch effect, so deeper chains cost one more validated attempt, not a
  weaker gate.
- The five Devin additions run `permissionMode: dangerous`, which approves
  every tool call without prompting; manager assignments to those lanes must
  bound scope and required tests, exactly as `worker-devin` and
  `reviewer-devin` already required.
