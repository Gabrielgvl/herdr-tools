---
name: tdd
description: Read before implementation or test work to choose a task-appropriate verification loop.
---

Use tests-first as the **provisional default** when the contract is clear and a meaningful executable oracle can be written before implementation, especially for a reproducible regression. This is a risk-control default, not a claim that TDD or any ordering is universally proven superior. When the oracle is still being discovered, choose a task-appropriate protocol below and record that choice; do not promote an alternative to the default from this guidance.

## Protocol status

- **RETAIN_AS_CONTROL:** criterion-to-evidence mapping, meaningful positive and negative checks, fail-for-the-right-reason classification, configured native gates, effectful external evidence, and ADR/escalation/smallest-change/deviation discipline. These safeguards make no causal efficacy claim.
- **PROVISIONAL_DEFAULT:** tests-first for clear contracts and reproducible regressions. The first check must be a meaningful failing check that exercises the intended behavior and is capable of distinguishing an incorrect implementation.
- **REASONABLE_TO_TEST:** tests-after for exploratory or characterization work; verifier/property/mutation-first for fault classes such as parsers, state machines, and transformations; an acceptance-invariant trace then tests; a mixed protocol for infrastructure, UI, runtime, or migration work; and independent QA for high-risk output when independence is concrete. These are options to evaluate, not established defaults.
- **NOT_PROVEN:** universal strict red-green superiority, a universal task-conditional ordering, a mandatory second QA agent, any numeric coverage or sample-size constant, and transfer of human TDD effects to coding agents.

## Evidence contract

Every acceptance criterion must have at least one verification mapping to one of:

- a structured local test-case mapping;
- a property or contract check; or
- deterministic external evidence.

Ordinary criteria have one mapping. Effectful criteria may have both one local mapping and one deterministic
external mapping; each mapping kind must be unique for that criterion. A structured test-case mapping names the
exact `criterion` and cases with a `description`, `type`, `expected` observation, `priority` (`must` or `should`),
and explicit `polarity` (`positive` or `negative`). A plan must cover every acceptance criterion: no empty plan,
unrelated criterion, duplicate same-kind mapping, or omitted criterion is acceptable. For disjoint parallel work,
each local test-case mapping also names its owning `fileAreas`; partitions receive only their scoped local mappings.

For a criterion that cannot be verified locally, the `UNTESTABLE` mapping is structured and must contain:
`criterion`, `reason`, `evidence.kind` (`command`, `procedure`, or `artifact`), `evidence.runner` (an allowlisted
safe runner), `evidence.value` (the exact safe reference), `expectedObservation`, and `authoritySafetyNotes`.
A clarification-only string is invalid, and `UNTESTABLE` never means silently unverified. The single serialized
post-integration evidence owner executes or inspects the reference only in the approved disposable/safe
environment and returns a receipt bound to the delivered revision; candidate, partition, and delivery writers
cannot attest it.

Include meaningful positive and negative evidence. Positive evidence demonstrates the intended result. Negative evidence demonstrates rejection, safe failure, preservation, or the absence of an unauthorized effect. A weak “does not throw” assertion, an unasserted mock, a fixture that bypasses the changed path, or a check that cannot fail when the behavior is wrong is not evidence.

**Fail for the right reason.** When tests-first is selected, before implementation execute the selected check and classify the result. An assertion failure for the intended missing behavior is a useful red result; a setup, dependency, tool, environment, or harness failure is not. For tests-after, verifier-first, mutation-first, mixed, or independent-QA protocols, run the selected baseline/oracle check at the protocol-defined point and classify it without manufacturing a red result. Resolve or report setup, dependency, tool, environment, or harness failures separately rather than calling them failing tests.

Reject immediate-green and vacuous checks. If a check passes when first written, stop and verify that it reaches the intended path, asserts the contract, and fails for a deliberately incorrect candidate. Correct or replace it, or record that the behavior already exists and add a meaningful negative or independent contract check; do not manufacture a red phase or claim the green result proves the change.

## The cycle

### Phase 1 — Load context

1. Read the sub-ticket description, acceptance criteria, and any `Context Files to Load` list.
2. Load every referenced ADR and context document from the sub-ticket.
3. Read the architecture-plan section for this ticket.
4. Read existing code, checks, and test patterns in the relevant packages. Match the target repository's conventions.

### Acceptance-invariant trace

Before writing checks, create a compact trace from the approved acceptance criteria and architecture plan:

| Criterion | Verification mapping: test name or property/contract/external evidence | Expected mutation | Expected non-mutation |
|---|---|---|---|
| The exact requirement or preservation rule | The check or deterministic evidence that proves it | State or files that may change | State or files that must remain unchanged |

- Include every criterion, including preservation language such as “unchanged,” “manual,” “must not,” and “only”. These are testable negative requirements, not background prose.
- Map each criterion to meaningful positive and negative evidence. If a criterion cannot be mapped to a test, mark it `UNTESTABLE` with the complete structured mapping (`criterion`, `reason`, `evidence.kind`/`evidence.value`, `expectedObservation`, and `authoritySafetyNotes`) and name the deterministic external evidence required; `UNTESTABLE` never means silently unverified.
- For effectful criteria, identify the external evidence in the mapping before implementation and preserve the exact target, revision, and result needed to interpret it.
- Assert both the intended target mutation and every protected environment or resource remains byte-for-byte unchanged where the criterion requires preservation.
- Use the trace while naming and writing tests or other checks so each check or deterministic `UNTESTABLE` verification maps visibly to its criterion. The trace is a pre-implementation working checklist, not a new workflow output field.
- Stop and escalate if the trace contradicts an ADR, approved criterion, existing check, or implementation behavior. Do not rewrite the criterion to match current code.

### Phase 2 — Design and write evidence

5. If a TDD plan (`$TDD_PLAN`) was provided, use it as the check-design specification:
   - implement every `must` case;
   - implement `should` cases unless a concrete reason is recorded;
   - add cases when the acceptance criteria or fault model requires them; and
   - record every skipped, modified, or added case in the deviation report.

   If the plan marks a criterion `UNTESTABLE`, preserve the complete structured mapping. Candidate and integration writers do not run those mappings; one serialized post-integration evidence owner executes or inspects each named deterministic evidence source exactly once and records the criterion, evidence kind/runner/value, expected observation, observed observation, pass result, exact delivered revision, mechanically verifiable receipt, and safety notes. Do not silently omit it or replace it with a clarification request. An unavailable or unsafe mapping fails closed unless current-session owner provenance and an explicit criterion-scoped owner authorization are present; the resulting waiver is recorded as `passed:false`. Without a plan, design checks directly from the acceptance criteria and the domain's edge cases.

6. For the provisional tests-first default, write meaningful positive and negative native test or contract checks before implementation. Use tests-after, verifier-first, or another `REASONABLE_TO_TEST` protocol only when the task shape makes it more appropriate; record why without presenting that choice as proven. Do not force an artificial red test when the selected protocol is not tests-first. A parallel partition may implement only its scoped test-case mappings; it must not execute another criterion's external evidence.
7. Run the target repository's configured test or check command before implementation when tests-first is selected. Confirm that any red result is for the intended behavior and not setup or environment failure. If the check is immediately green, apply the immediate-green rule above.

For fail-closed branches, the fixture set must include at least one recoverable-class error and one ambiguous-class error, asserting different outcomes; a single "throttling" fixture proving the stop is not sufficient.

### Phase 3 — Implement and verify

8. Make the smallest change that satisfies the mapped criteria. Do not add speculative abstractions or refactor unrelated code.
9. Run the target repository's configured build, test, lint, format, and type checks that are relevant to the changed surface. Keep positive, negative, and preservation evidence in the final result.
10. Run the configured coverage target when the repository provides one. Coverage is a configured diagnostic floor, never a correctness proof; it cannot replace meaningful assertions, property/contract checks, or external evidence. Do not invent a command, impose a universal numeric floor, or claim a coverage result for a command that was not run.
11. Run applicable effectful evidence before declaring completion. A unit test or mock is not proof of deployed or externally observable behavior.

## Repository-native checks

Discover commands from the target repository's documentation and configuration, then run the exact native targets for the changed surface. Use the repository's task runner, package manager, build system, or project targets as configured; do not assume a particular package manager or substitute guessed commands. If a relevant check is not configured, report it as not configured rather than inventing a command or treating its absence as a universal blocking gate. Repository-specific required gates still apply when they are explicitly configured.

## Effectful criteria

When an acceptance criterion can change infrastructure, UI, runtime behavior, or an external data path, map and run the applicable deterministic evidence in addition to local checks. In the dynamic execution workflow, run it only in the serialized post-integration evidence stage, once against the integrated candidate; partitions and integration writers have no external-evidence authority. Depending on the criterion, this can include:

- infrastructure synth, plan, template, or generated-artifact validation;
- a permitted dev deployment and representative smoke check;
- a browser interaction or rendered-state check;
- telemetry, logs, or other observable runtime evidence; and
- a read-after-write check against the authoritative data path.

Name the target, revision, command or procedure, and observed result. Use only evidence applicable to the criterion and the repository's authorization policy. Do not claim that a mocked effect, local unit test, or compilation establishes deployment, IAM, browser, timing, queue, region, or runtime wiring.

## Independent QA

Independent QA is evidence-independent, not merely another opinion. Qualifying independence includes a hidden or immutable check not shared with the implementation agent, a different context and model with the acceptance contract but not the implementation's test rationale, independent acceptance cases authored without the implementation's test rationale, a property or mutation check, or a deterministic verifier with a separate oracle. A second agent alone is not independent; shared prompts, visible tests, context, fixtures, or evaluator logic preserve correlated blind spots. Independent QA is a task-conditional option marked `REASONABLE_TO_TEST`, not a default QA-agent requirement.

## Smallest change, ADRs, and deviations

Preserve applicable ADR rules and escalate an ADR conflict rather than weakening the criterion or working around it. Report deviations from the TDD plan, architecture plan, and ticket scope. A small change means the smallest coherent implementation and its required evidence, not an excuse to omit negative or external checks.

Every run must include:

- **TDD plan deviations:** each skipped, modified, or added case versus `$TDD_PLAN`, with its justification; if none, state `TDD_PLAN_DEVIATIONS: NONE`.
- **Architecture plan deviations:** non-ADR deviations and why. An ADR `MUST` or `MUST NOT` conflict is an escalation, not a hidden deviation.
- **Scope deviations:** any change outside the ticket's stated scope and why it was unavoidable.
- **Concerns for the code reviewer:** open questions, deliberately unchanged risks, evidence limitations, and areas needing extra attention.

## Commit cadence

WIP commits are resilience guidance: use meaningful save points when they improve recovery or handoff, following the repository's workflow. They are not correctness evidence, and artificial tiny slicing is not mandatory. Never use a commit, a clean diff, or a passing visible check as a substitute for the verification mapping and evidence contract.

## Escalation

Stop and return a structured error rather than guessing or working around when:

- an ADR `MUST` or `MUST NOT` rule would be violated;
- acceptance criteria are ambiguous or contradictory;
- the plan requires an unmade dependency, interface, or data-model decision;
- a required deterministic evidence path is unavailable, unsafe, or unauthorized and no explicit owner-authorized exception records authority identity, authority reference, and exact criterion scope; or
- existing checks fail in an unanticipated way and fixing them is outside scope.

## Output contract

Return:

- files created or modified;
- the repository-native configured check summary, including coverage only when its configured command was run;
- the verification mapping outcome for every acceptance criterion, including the exact structured observation, delivered revision, and runner receipt for each deterministic `UNTESTABLE` criterion;
- effectful evidence for applicable infrastructure, UI, runtime, and external-data criteria;
- `TDD_PLAN_DEVIATIONS`, `ARCHITECTURE_PLAN_DEVIATIONS`, `SCOPE_DEVIATIONS`, and `CONCERNS_FOR_REVIEWER`; and
- any escalations or evidence that remains not proven.
