# Herdr Tools

A Pi extension that turns the Herdr terminal multiplexer into a supervised, profile-gated multi-agent runtime. This glossary fixes the language used across SPEC.md, the ADRs, and the code.

## Language

### Delegation

**Profile**:
A named, typed launch contract — runtime, model, permissions, tools, timeout, fallback chain — for one role on one runner. Launch is profile-only.
_Avoid_: agent config, preset, template

**Role**:
The job family a profile serves (manager, planner, promoter, researcher, reviewer, scout, worker). Expressed by profile naming and catalog position, not by a typed field.
_Avoid_: kind (kind means runner type: pi, claude, agy, devin)

**Reviewer**:
Judges a running child's progress from transcript evidence into one of progress, stalled, blocked, risk, appears_complete, unknown. Not the router.
_Avoid_: router, judge, verifier

### Routing

**Jev**:
TypeSafe's decision-only model: typed questions in, calibrated probabilities out, no generated text. Serves the reviewer and the router.
_Avoid_: classifier, LLM

**Batch**:
One launch request without a profile that the router expands into multiple children.
_Avoid_: parallel launch, fan-out request

**Assignment**:
One entry of a RouteDecision: a profile, a count, and a purpose.
_Avoid_: task, job

**Router**:
The Jev-backed layer that decides how a delegable task is dispatched — role, profile, and fan-out — before any agent is launched.
_Avoid_: scheduler, recommender, planner

**RouteDecision**:
The router's output after deterministic policy is applied: the concrete assignments (profile, count, purpose) the caller executes.
_Avoid_: recommendation, suggestion, plan

**Abstain**:
The router declining to decide because confidence is below threshold; the caller routes as it does today.
_Avoid_: unknown (reserved for the reviewer), fallback (reserved for profile failure chains)

**Fan-out**:
The number and mix of agents the router assigns to one task: single, parallel same-role, or mixed roles.
_Avoid_: parallelism, strategy
