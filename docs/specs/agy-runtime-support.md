# Spec: First-class AGY runtime support

## Scope

This is a Herdr Tools-only change. It adds AGY profile support without changing Herdr
Core, AGY, or the existing Pi/Claude contracts. The implementation and its focused unit
and disposable integration coverage are live on the feature branch.

AGY is a reduced-assurance exception because its native session identity may be absent
until after the first prompt. The exception is limited to AGY and is explicit rather
than hidden behind a fallback or compatibility path.

## Runtime contract

Add `agy` as a strict runtime kind and bundle `researcher-agy`, `scout-agy`, and
`worker-agy`:

```yaml
runtime:
  kind: agy
  model: gemini-3.8-flash-high
  mode: plan # or accept-edits; fixed by the profile
  addDirs: []
```

- An AGY launch **requires the mandatory typed `assignment`** of exactly `objective`,
  `scope`, and `verification`, like every other launch. A missing, malformed, or extra
  assignment field is rejected before mutation. There is no promptless launch path and
  no AGY-specific prompt requirement any more, so no AGY fallback is pruned from a
  launchable chain.
- `sessionPersistence: true` is required. AGY has no non-persistent flag.
- The fixed argv is `--model <model> --mode <profile.mode> --dangerously-skip-permissions`,
  where the required fixed mode is exactly `plan` or `accept-edits`, followed by
  scope-normalized `--add-dir` values and the tools-owned recipient attachment
  directory. No `--agent`, prompt file, arbitrary argv/env, or hidden profile-body
  input is accepted, and mode is not launch-overrideable.
- Only typed primary overrides `model` and `addDirs` are allowed. Overrides never leak
  into fallbacks; fallback profiles keep their own defaults.
- `researcher-agy` uses `plan` and falls back to `researcher-claude`, yielding exactly
  `researcher-agy -> researcher-claude -> researcher-pi`. `scout-agy` uses `plan` and
  yields `scout-agy -> scout-claude -> scout-pi`. `worker-agy` uses `accept-edits` and
  falls back to `worker-claude`; the implementation default `worker-devin` yields
  exactly `worker-devin -> worker-agy -> worker-claude`, and `worker-pi` remains
  selectable with `worker-pi -> worker-agy -> worker-claude`.
- The required Markdown body remains catalog metadata. AGY receives repository
  `AGENTS.md` through its native discovery and receives the manager's one explicit,
  visible v1 provenance-wrapped assignment through the existing prompt channel.

Effective model-visible details expose the AGY kind, actual fixed mode,
`dangerouslySkipPermissions: true`, persistent-session permission, and bounded
`addDirs`. The worker's `accept-edits` mode plus permission bypass can auto-approve
mutations, so manager assignments must bound scope and required tests.

## Provisional state and job-registry publication

The public supervision state adds one discriminated value, `provisional`. It is legal only
for an AGY supervisor. `reserved` remains the pre-readiness reservation state. `active` and
`degraded` remain post-strengthening exact-session states; Pi and Claude cannot enter
`provisional`.

The AGY provisional publication is a real job-registry publication, not an internal flag:

- It exposes `state: "provisional"` through the supervisor job view together with the
  proven pane, terminal, name, kind, profile, and lifecycle baseline as provisional
  evidence. It never claims or publishes a full native `agent_session`.
- The job remains `operation_phase: "running"` and `childLive() === true`. `herdr_jobs
  cancel` therefore refuses it with `SUPERVISION_ACTIVE`, and session shutdown remains
  the only manager-controlled cancellation path.
- Provisional state never counts as exact coverage. The registry keeps
  `request.targetIds: []`, `activeSupervisorFor` and semantic-review ownership ignore it,
  and no recipient or attachment capability is registered from it. A pane or terminal
  shown in the provisional view is evidence for inspection, not an exact identity claim.
- The registry uses a provisional `commit` and `publish` operation on the same mutation
  control as exact binding. `commit` changes the private job/request state, `publish`
  notifies observers only after the supervisor state matches, and rollback restores the
  reserved request without settling or releasing the provisional job. Strengthening is
  the only operation that can publish the exact target and coverage.

A failed AGY launch after provisional publication leaves this running, non-cancellable
provisional job and its recovery evidence in place. Launch failure does not call
reservation release, settle the supervisor, clean up the child, or register a recipient.
The supervisor may settle later only from its own authoritative lifecycle or manager
session shutdown.

## AGY launch state machine

The normal profile-only launch, 120-second selected-attempt budget, attachment
publication, and reservation-before-topology-mutation rules remain in force. AGY then
uses this reduced-assurance sequence:

1. **Pre-prompt readiness.** A fresh coherent readiness sample must prove the exact pane,
   terminal, name, `agent: "agy"`, `interactive_ready: true`, idle lifecycle, and safe
   baseline sequence/revision. Missing native `agent_session` is allowed at this stage;
   records are never merged across samples. Contradictions, malformed fields, duplicate
   records, or replacement fail closed.
2. **Provisional publication.** After readiness, commit and publish the AGY-only
   provisional supervisor through the existing supervisor and job-registry mutation
   chain. It is live and non-cancellable, but it is not exact coverage and does not
   publish an exact target ID.
3. **Single submission.** Send the mandatory visible v1 envelope through exactly one
   `herdr agent prompt <pane> --stdin` submission. The acknowledgement must match the
   provisional pane/terminal/name/kind identity. There is no second submission, separate
   Enter, wait, or prompt recovery.
4. **Native-session confirmation.** Within the existing semantic confirmation window
   (5,000 ms at the existing 100 ms cadence), read fresh authoritative state. Before
   success, the official full AGY `agent_session` identity must appear on the same pane,
   terminal, name, and kind, with lifecycle `state_change_seq` strictly greater than
   the pre-prompt idle baseline and no revision regression. Snapshot, agent, and pane
   evidence must remain coherent.
5. **Atomic strengthen.** Run the observer-backed strengthening transaction defined
   below. Only after its exact-session commit may the job registry publish exact coverage,
   and only after that commit plus semantic assignment confirmation may launch report
   success or register the exact recipient and attachment capability.
6. **Steady state.** Once strengthened, the existing exact-session supervision,
   identity-preserving move, reconciliation, notification, and session-lifetime rules
   apply unchanged.

## Strengthening transaction

Strengthening is not a setter that copies a session value found by an earlier read. It is
one observer-backed task on the existing supervisor mutation chain:

1. Mark strengthening pending while the provisional observer remains registered and
   continues admitting events. Take a fresh authoritative `session.snapshot` at
   strengthen time and require exactly one valid occupant for the provisional pane.
2. Require that occupant to preserve the provisional pane, terminal, name, and AGY kind,
   and to carry the official full native `agent_session`. Require a valid lifecycle
   transition with `state_change_seq` strictly greater than the pre-prompt idle baseline
   and a revision that does not regress from the provisional anchor.
3. Drain every event admitted during the provisional window, in arrival order, before
   committing. Validate the same lifecycle and revision rules against the drained
   evidence. A move, replacement, contradiction, duplicate or malformed record,
   settlement, identity mismatch, failed read, lifecycle failure, or revision regression
   rejects strengthening.
4. Only after the fresh read and queued-event drain pass does the supervisor commit the
   full native-session identity. The existing job-registry publication then atomically
   commits the exact child request and publishes the matching `active` or `degraded`
   state, exact `targetIds: [paneId]`, and exact-identity coverage. No observer sees a
   half-strengthened supervisor. Recipient and attachment registration occur only after
   this publication and semantic assignment confirmation.
5. If any step fails, rollback only uncommitted exact-publication changes. Retain the
   provisional supervisor, its running non-cancellable job, evidence, and recovery
   handles. Do not settle or release the reservation, retry or fall back, clean up the
   child, submit another prompt, or register a recipient.

A contradiction, timeout, move before strengthening, failed/ambiguous read, or missing
native session is a visible partial-effect failure. It does not retry, fall back, clean
up, release the child or provisional recovery handle, register a recipient, or continue
dependent work. Preserve the child, evidence, and recovery handles for inspection.

The sole fallback exception remains the existing exact, non-killed,
untruncated pre-interactive `agent_start_failed` envelope followed by fresh authoritative
proof that no agent exists. Only then may the chain advance from AGY to Pi to Claude.
No readiness, prompt, identity, supervision, timeout, or uncertain-effect failure may
select a fallback.

## Deterministic safety matrix

This matrix is normative for the launch unit tests and the disposable integration. Tests
must count prompt, start, fallback, cleanup, reservation-release, and recipient-registration
calls, and must inspect the published job state rather than infer it from an error string.

For every AGY failure row that occurs after provisional publication, `P` means all of the
following are asserted: launch does not report success, there is no second stdin
submission, no retry, no fallback start, no cleanup, no reservation release, no recipient
or attachment registration, and the same provisional supervisor remains published as
`operation_phase: "running"`, `state: "provisional"`, live, and non-cancellable. The
provisional job is not exact coverage.

| Scenario | Required deterministic result |
| --- | --- |
| AGY launch with a missing or malformed `assignment` | Reject before mutation. Start, focus, prompt, reservation, cleanup, fallback, and recipient calls are all zero. |
| Missing pre-session `agent_session` for AGY | Accept only the AGY readiness sample and publish provisional state. No exact coverage is exposed before strengthening. |
| Missing pre-session `agent_session` for Pi or Claude | Preserve their current strict readiness requirement. Reject before assignment and never enter the AGY provisional path. |
| Assignment submission | Dispatch exactly one `herdr agent prompt <pane> --stdin` submission. Never send a second prompt, separate Enter, wait, or recovery submission. |
| Acknowledgement identity mismatch | Partial-effect failure and `P`. |
| Prompt transport failure or ambiguous transport result | Partial-effect failure and `P`. |
| Fresh occupant identity mismatch or replacement | Partial-effect failure and `P`. |
| Duplicate pane or agent evidence | Treat as invalid evidence, fail closed, and apply `P`. |
| Move before strengthening | Partial-effect failure and `P`; do not follow the destination as exact identity. |
| Failed, malformed, or contradictory authoritative read | Partial-effect failure and `P`. |
| Semantic confirmation timeout | Partial-effect failure and `P`. |
| Missing, malformed, or changed native session after the prompt | Partial-effect failure and `P`. |
| `state_change_seq` not strictly greater than the idle baseline | Partial-effect failure and `P`. |
| Revision regression or otherwise unvalidated revision | Partial-effect failure and `P`. |
| Strengthening or atomic job publication failure | Partial-effect failure and `P`; no exact job publication may remain visible. |
| Exact pre-interactive, non-killed, untruncated `agent_start_failed` with fresh proof of no agent | The only permitted fallback case. The failed attempt has no prompt effect, may release its unused reservation, and may advance to the declared next profile. |

The final row is the only exception to `P`. Every acknowledgement, transport, identity,
duplicate, move, read, timeout, session, sequence, revision, or strengthening failure
must retain the provisional supervisor and must not retry, fall back, clean up, release
its reservation, or register a recipient.

## Residual risk accepted for AGY only

During the short provisional window, pane/terminal/name/kind continuity is not
cryptographic attribution. A same-terminal, same-kind replacement or a stale
pane-scoped hook report could appear to be the started child. Tools cannot eliminate
that risk without a Core change. The owner accepts this AGY-only exception, bounded by
the existing confirmation window and the requirement for a later official native
session plus lifecycle advancement. Pi and Claude retain strict full identity before
assignment and are not weakened.

## Unchanged contracts

- `profile` is required; raw kind, argv, and env launch paths remain rejected.
- The visible v1 sender envelope and `authority: agent; not user/owner` remain mandatory.
- Prompt injection is single-submit and non-idempotent; unknown or possible effects stay
  visible and terminal.
- Recipients and attachments are identity-bound and unavailable until AGY strengthening
  and semantic confirmation succeed.
- Pi and Claude retain their current complete pre-prompt native-session readiness and
  exact-session supervision with no behavior change.
- No generic fallback, legacy parser, hidden prompt channel, automatic cleanup, or
  AGY-specific second transport is added.

## Implementation slices

Every slice changes at most five files. Keep each slice green before the next; do not
execute these slices as part of this documentation revision.

### Slice 1: strict profile and adapter support

Files: `src/profiles/types.ts`, `src/profiles/parser.ts`,
`src/profiles/adapters.ts`, `src/profiles/capability.ts`.

Add the discriminated AGY runtime, exact fields, fixed argv, normalized `addDirs`,
required persistence, attachment capability, and prompt-source rejection. Preserve
Pi/Claude behavior and reject unsupported fields.

### Slice 2: provisional state and job publication

Files: `src/supervision/state.ts`, `src/job-registry.ts`,
`test/unit/job-registry.test.ts`, `test/unit/supervision-projection.test.ts`.

Add the AGY-only `provisional` state and the registry publication contract. Test that a
provisional job is visibly running, live, and non-cancellable while its empty
`targetIds` and lack of exact coverage remain explicit. Test commit, publish, and rollback
without settling or releasing the provisional job.

### Slice 3: provisional supervisor and registry

Files: `src/supervision/identity.ts`, `src/supervision/registry.ts`,
`src/supervision/supervisor.ts`, `test/unit/supervision-identity.test.ts`,
`test/unit/supervision-registry.test.ts`.

Add AGY-only provisional binding before the single submission. Keep the observer
registered through strengthening, use the existing ordered mutation chain, and preserve
Pi/Claude exact binding. Test the provisional-to-exact transition and rejection of
pre-strengthening moves, contradictions, replacements, and mismatched sessions.

### Slice 4: strengthening edge coverage

Files: `test/unit/supervisor.test.ts`, `test/unit/supervision-edges.test.ts`.

Test the fresh exact-occupant read, queued-event drain, lifecycle and revision checks,
atomic job commit/publication, and every strengthening failure. Each failure must retain
the provisional supervisor and its recovery handle without exact coverage.

### Slice 5: launch and inspection

Files: `src/tools/launch.ts`, `src/tools/inspect.ts`, `src/launch-schema.ts`,
`test/unit/launch.test.ts`, `test/unit/inspect.test.ts`.

Require the typed `assignment`; implement the pre-prompt reduced-assurance baseline, one
submission, 5-second native-session/lifecycle confirmation, strengthen-before-success,
recipient ordering, and exact zero-effect fallback. Implement every row of the
deterministic safety matrix above as call-count and published-state assertions. Keep
Pi/Claude readiness unchanged.

### Slice 6: recipients and attachments

Files: `src/tools/communicate.ts`, `src/messages/recipients.ts`,
`src/messages/store.ts`, `test/unit/messages.test.ts`,
`test/unit/communicate.test.ts`.

Reuse the existing identity-bound registry and attachment store. Test that AGY
registration and attachment delivery require the strengthened exact identity and that
replacement, missing capability, and directory mismatch fail closed.

### Slice 7: bundled profile and catalog guidance

Files: `herdr-profiles/researcher-agy.md`, `herdr-profiles/scout-agy.md`,
`herdr-profiles/worker-agy.md`,
`herdr-profiles/role-plugins/manager/skills/manager/SKILL.md`,
`test/unit/profile-catalog.test.ts`.

Add the three profiles, recommend the scout and researcher AGY defaults, route worker
fallbacks through worker AGY, move catalog assertions from 13 to 15, and state that
every AGY assignment is self-contained and provenance-wrapped; profile bodies never
reach AGY.

### Slice 8: living documentation

Files: `README.md`, `SPEC.md`, `docs/specs/profile-backed-delegation.md`,
`docs/specs/manager-profile-capabilities.md`,
`docs/specs/large-agent-communications.md`.

Update current catalog/runtime/attachment statements to include AGY without rewriting
historical ADRs.

### Slice 9: disposable AGY integration

Files: `test/integration/disposable-session.ts`,
`test/integration/herdr-tools.integration.test.ts`,
`test/integration/herdr-mcp.integration.test.ts`, `scripts/test-integration.ts`.

Use the existing condition-based integration helpers in a disposable named session.
Exercise successful provisional-to-native strengthening, exact identity supervision,
attachment access, the single prompt, and only the proven pre-interactive AGY-to-Pi
fallback. A skipped AGY run is not a pass; the active user session is never mutated.

## Qualification

After implementation, qualify the exact candidate revision with:

```bash
npm run test:unit
npm run typecheck
npm run lint
npm run build
npm run build:mcp
npm run validate:plugin
HERDR_TOOLS_RUN_INTEGRATION=1 HERDR_TOOLS_RUN_AGY_INTEGRATION=1 npm run test:integration
git diff --check
```

The AGY integration must prove the native-session confirmation and provisional supervisor
transition. The launch unit tests must execute every safety-matrix row and assert the
no-retry, no-fallback, no-cleanup, no-release, and no-recipient invariants. Any missing,
contradictory, moved, timed-out, or ambiguous evidence blocks release; it is not a reason
to retry, clean up, release the provisional job, or weaken Pi/Claude.

## Out of scope

- Any Herdr Core, AGY CLI, or integration change; this design consumes existing reports.
- Promptless AGY launches, raw launch inputs, hidden/system prompt injection, arbitrary
  argv/env, alternate transports, prompt retries, separate Enter, or uncertain cleanup.
- Fallback after assignment or after any possible/unknown effect.
