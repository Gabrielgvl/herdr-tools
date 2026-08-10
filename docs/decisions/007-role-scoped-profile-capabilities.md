# ADR-007: Give bundled profiles role-scoped capabilities

## Status

Accepted

## Date

2026-08-10

## Context

The profile-backed delegation slice now launches visible Pi and Claude workers through reusable bundled profiles. An unrestricted inherited tool set would let read-only roles edit, let non-manager roles recursively delegate, and leave orchestration responsibilities ambiguous. Pi and Claude also need one shared role method without relying on machine-global package paths.

ADR-006 established the profile catalog, visible Herdr launch architecture, and five bundled implementation roles. This decision refines the bundled profile surface; it does not change the catalog, fallback graph, prompt-source, provenance, or owner-authority architecture.

## Decision

Add one bundled `manager-pi` profile using `openai-codex/gpt-5.6-sol` with high thinking, a 30-minute timeout, no persistent session, and no fallback. It may inspect evidence, launch and communicate with visible workers, wait on authoritative states, arrange or clean up owned panes/tabs, and synthesize results. It has no Bash, edit, or write capability and never grants authority or implements repository changes. There is no `manager-claude` profile because Claude has no native Herdr extension-tool parity in this release.

Give every bundled profile an explicit role-scoped capability policy:

- Pi scout, planner, reviewer, and researcher profiles are read-only and omit direct edit/write and hidden delegation tools.
- Pi worker is the only role with `edit`, `write`, `bash_bg`, `jobs`, `job_decide`, and `monitor`.
- Only the manager receives Herdr lifecycle tools, including `herdr_tab`; non-manager Pi profiles omit Herdr lifecycle tools, `Agent`, `agent_bg`, and durable-memory mutation tools.
- Claude scout, planner, reviewer, and researcher profiles use `permissionMode: dontAsk`, explicitly pre-approve their read/research tools, and disallow `Edit`, `Write`, `NotebookEdit`, and `Task`.
- Claude worker uses `permissionMode: acceptEdits`, pre-approves its implementation and research tools, and disallows `Task`.

Package six scope-local Claude plugins, each with one role `SKILL.md`. Each Pi profile points at the same role skill path, and each Claude profile points at its role plugin directory. Normal installed extension discovery remains enabled: profile allowlists select inherited tools by name, while missing task-critical extension capabilities remain visible blockers rather than being replaced by unspecified fallbacks. Runtime resource paths continue to use the existing strict profile-scope validation.

A disposable integration run proved that Herdr can place a multiline provenance envelope in a newly created Pi pane without the final Enter being accepted. Profile launch now gives Herdr a 10-second wait budget so its native effect check can report exact `cli:agent:prompt` `agent_prompt_stalled` evidence after five seconds with no state change while status remains idle. Only for that evidence does launch send one lowercase `enter` to the newly created owned pane and re-verify `working`. Non-matching failures and pre-existing panes never receive this recovery. This is bounded submission completion, not a generic launch fallback.

## Alternatives considered

### Keep all inherited tools available

Rejected because read-only roles could mutate repositories and non-manager roles could silently create hidden delegation paths.

### Add a Claude manager profile

Rejected because Claude lacks the native Herdr extension-tool parity required for visible manager orchestration. Adding one would create a role that could not satisfy the manager contract honestly.

### Disable extension discovery or use machine-global plugin paths

Rejected because bundled profiles must work with normal installed extension discovery and cannot assume portable machine-global package locations. The profile remains explicit about selected tool names and local role resources.

### Add compatibility aliases or capability fallbacks

Rejected because aliases would weaken the strict profile contract and fallbacks could mask an unavailable task-critical capability. A blocked capability must remain visible.

## Consequences

- The bundled catalog contains 11 effective profiles: one manager Pi profile plus five Pi/Claude role pairs.
- Shared role method is maintained once per role and consumed by both runtimes.
- Capability policy is inspectable in profile metadata and mechanically covered by unit and integration tests.
- Newly created owned panes recover from the verified multiline-composer submission failure with one bounded lowercase `enter` retry; unrelated prompt failures remain terminal.
- Read-only behavior still depends on role instructions for shell safety; direct edit/write tools are mechanically absent, while Bash remains available where the approved read-only matrix requires inspection commands.
- Existing model and fallback choices remain unchanged for the five original roles, and visible provenance and owner-authority boundaries remain governed by the existing Herdr contracts.
- A future Claude manager or broader capability policy requires a new decision and explicit owner approval.
