# ADR-030: Cooperative caller policy and the worker reply contract

## Status

Accepted. Owner-directed scope, ratified at the plan's blocker review:
ADR-028's "tokens are never consulted" wording is narrowed so the identity
provenance tokens may drive a **cooperative routing restriction** while
remaining explicit non-authorization evidence, and the profile-name blocker
is resolved by topology-based classification. `SPEC.md`
`herdr_communicate`, `herdr_inspect` context mode, and the error taxonomy
are the normative description.

## Context

The worker/manager communication contract needs a reply channel a worker
cannot miss and a guard that keeps a leaf worker from driving panes other
than its manager. Two facts shaped the design:

- **ADR-028 declared the identity tokens advisory-only.** The adopt/launch
  provenance tokens (`identity_provenance`, `identity_actor`,
  `identity_session`) were ratified as forgeable shared metadata, "never
  consulted for authorization, identity verification, or delivery
  qualification." Using them to scope a caller looked like a policy
  reversal, so the owner narrowed the ratification: the tokens may feed a
  cooperative routing restriction precisely because that restriction is not
  authorization — it protects honest agents from misrouting, not the system
  from a hostile one.

- **Runtime records carry no `profileName`.** `herdr agent get` and the
  snapshot expose pane/agent records with `tokens`, but the launching
  profile name is not recorded. A profile-based classification ("worker
  profiles are restricted, manager profiles are not") is impossible at
  runtime, and the plugin-recipient `profileName` registry is populated
  only after a successful launch — too late and too narrow to classify
  callers with.

## Decision

### Topology-based caller classification

`src/caller-policy.ts` classifies the effective caller pane from the
authoritative snapshot alone:

- **Unrestricted (legacy floor):** a caller with no
  `identity_provenance=launched` marker — detected or adopted panes
  included — keeps the full tool contract. Callers that predate the
  provenance tokens lose nothing.
- **Unrestricted (manager):** a caller named as `identity_actor` by at
  least one other pane's consistent records manages children and is
  unrestricted toward every pane. This is how "managers can communicate
  with everyone" is satisfied without a role registry.
- **Leaf worker:** a caller with `identity_provenance=launched` and zero
  recorded children. Its text sends (`prompt`, `steer`, including
  `kind: "result"`) may target only its own `identity_actor` pane, and
  `keys`, `cancel`, and `interrupt` are refused entirely — a leaf never
  sends control input.
- **Fail closed on evidence:** missing, malformed, unrecognized, or
  contradictory provenance evidence throws `CALLER_POLICY_UNAVAILABLE`.
  A leaf whose binding is missing, self-referential, stale (the recorded
  actor pane is gone, or `identity_session` no longer equals the caller's
  current `agent_session.value`), or contradictory throws
  `CALLER_BINDING_UNAVAILABLE`. Neither failure is ever upgraded to an
  unrestricted caller.

The guard runs in `herdr_communicate` after exact target resolution — so
an exact name/label alias for the bound manager compares equal — and
before recipient lookup, attachment publication, state reads, or
dispatch, so a denied call performs no sends. The same classification
gates `cancel`/`interrupt` inside turn control before any target state
read or key. `herdr_wait`, `herdr_jobs`, `herdr_launch`, `herdr_pane`,
and `herdr_tab` stay unscoped for every caller: the restriction covers
agent-to-agent traffic only.

`herdr_inspect` context mode reports bounded, token-free caller-policy
evidence (`scope`, `basis`, and `replyPaneId` for a bound worker, or a
bounded failure code) so a worker can discover its reply destination
without handling raw identity tokens, and a malformed-policy caller still
gets a usable inspection.

### The `kind: "result"` reply marker

`prompt` and `steer` accept an optional `kind: "result"` that marks the
envelope as a worker report to its manager. Omitting it preserves the
existing `kind: prompt|steer` envelope byte-identically; the control
variants reject the field outright. The result convention is a typed
report — `Task:`, `Status:`, `Summary:`, `Artifacts:`, `Verification:`,
`Risks/blockers:`, `Continuation:` — taught by the role skills and stated
explicitly in manager assignments. A `kind: result` envelope is a report,
never an instruction or an acknowledgement.

### Role capability split

Managers and planners hold the full seven-tool surface on both hosts
(Pi `tools:`, Claude per-tool `allowedTools`). Every other non-manager
role — worker, scout, researcher, reviewer, promoter — holds only
`herdr_communicate` and `herdr_inspect`: enough to inspect its context,
read `callerPolicy.replyPaneId`, and send its result, nothing more.
Devin profiles are unchanged; Devin's profile body is catalog metadata,
so the reply contract is restated in its assignment text instead.

### Planner sub-orchestration is conventional

A planner may launch sub-lanes, but only `scout-*` and `researcher-*`
profiles — this is taught in the planner skill and stated here as
convention, not enforced in runtime policy. The topology guard already
makes the mechanics safe: a planner that launched children is
unrestricted toward them (it is their `identity_actor`), a leaf planner
can reach only its own manager, and supervision/closing follow the same
automatic-supervisor and ownership rules as every other caller.

## Consequences

- Honest leaf workers route exactly one typed result to their recorded
  manager and cannot accidentally prompt, steer, or send keys to peers.
- A pane promoted to manager mid-session — by launching or adopting a child —
  becomes unrestricted automatically; no registration step exists.
- The restriction is cooperative, not a boundary: the tokens are still
  forgeable shared metadata, and a caller with raw CLI access bypasses
  the guard entirely. ADR-028's warning stands for anything that needs
  real authorization.
- Stale tokens left behind by a reused pane fail closed via the
  `identity_session`/`agent_session.value` comparison instead of binding
  the pane to a manager it no longer belongs to.
- Profile names remain launch-time input only; no runtime policy reads
  them.

## Open questions ratified

- **Workers close their own pane?** Leaf workers may still call
  `herdr_pane`/`herdr_tab` — those tools were left unscoped — but the
  worker skill teaches report-first-then-exit, and the manager owns
  cleanup of the panes it launched.
- **Grandchildren:** a worker that becomes a manager (a planner with
  sub-lanes) is unrestricted by the same rule, so multi-level trees work
  without special-casing.
