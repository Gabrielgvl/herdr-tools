---
name: release-pr-validation
description: Courier release PR validation workflow before author-scoped approval. Use when asked to validate, smoke test, approve, or review a release PR in any trycourier repository.
---

# Courier Release PR Validation

This skill is the mandatory workflow for Courier release PR approvals across **any `trycourier/*` repository**. Always infer the repository from the release PR URL whenever possible. Never hard-code a repository, checkout path, workflow filename, branch name, region, or job name unless current repository evidence establishes it.

## Non-negotiable approval standard

Do **not** approve from checks, deploy status, health checks, or log scans alone. Approval requires comprehensive validation of every selected PR's production-impact behavior.

Never post PR comments or review body text during release validation. If approval is warranted, approve with no body/comment unless the user explicitly asks for one. This is mandatory even if the user's pasted workflow, checklist, or command example includes `--body`, `--comment`, or validation-summary text; omit those flags and use approval-only by default.

A valid release validation must include:

1. Correct repository resolution for the release PR and all selected PRs.
2. GitHub PR checks collected for every selected PR as informational context only.
3. Proof that the staging deployment being tested contains every selected PR.
4. A PR-specific smoke matrix based on changed files and behavior.
5. Executed happy-path and important edge-case validation for every runtime-impact selected PR.
6. Explicit residual-risk notes for any scenario that cannot be safely tested in staging.

PR check failures, cancellations, pending states, and skipped checks do **not** block release approval. The release gate is the applicable smoke test against a proven deployed staging head.

Do **not** declare the release blocked from a planning result, a subagent's `blocked` label, the absence of a natural failure in logs, or an unexecuted first-pass scenario. Planning identifies what to test; it is not test evidence. Before a final blocked decision:

1. discover credentials, endpoints, deployed identities, and safe fixtures from the sources below;
2. execute every safe read-only and non-destructive functional scenario available;
3. when an isolated synthetic write or controlled fault could provide the missing evidence, ask for explicit staging-write/fault authorization instead of ending the workflow;
4. after authorization, run the scenario, verify its effects and cleanup, then re-evaluate the release;
5. block only after an attempted validation fails, or a concrete prerequisite remains unavailable after discovery and any requested authorization.

If credentials, test data, staging URLs, AWS access, safe write paths, or deployed-head evidence remain unavailable after that process, report **blocked**. Do not substitute availability checks for functional tests.

## Inputs

- Release PR URL or number.
- Author login. If empty, resolve with:

```bash
gh api user --jq .login
```

If the release PR is missing, stop and ask for it.

## Repository resolution

Always resolve the GitHub repository before fetching PR metadata. Repository resolution is part of the validation contract, not a convenience step.

1. If the release input is a full GitHub PR URL, parse `<owner>/<repo>` from the URL and set:

```bash
REPO="<owner>/<repo>"
```

2. If the release input is only a PR number, infer the repo from the current child repo/worktree remote:

```bash
gh repo view --json nameWithOwner --jq .nameWithOwner
```

3. If the inferred repo is ambiguous or the PR number does not resolve, ask for the release PR URL.
4. Do **not** switch repos silently. If user wording, prior session state, or this skill's directory/name says one repo but the PR URL points to another, the PR URL is authoritative. Follow the PR URL, validate that repository's workflows, and call out the mismatch in the final report.
5. Work from a matching local child repo/worktree when available.
   - Resolve candidate checkouts from their `origin` remotes and compare the normalized `owner/repo` with `$REPO`; do not infer the repo from a directory name alone.
   - If more than one matching checkout/worktree exists, prefer the clean checkout already intended for release validation or ask which one to use before running repo-specific commands.
   - If no matching checkout exists, use `gh --repo "$REPO"` from the workspace without editing files. Local git is optional when GitHub compare/history can prove containment.

## Metadata and selected PRs

Resolve release PR metadata:

```bash
gh pr view <release> --repo "$REPO" --json number,url,title,commits
```

Extract merged PR numbers from commit headlines matching:

```text
Merge pull request #<n>
```

For each merged PR:

```bash
gh pr view <n> --repo "$REPO" --json number,title,url,author,mergeCommit,files,state
```

Keep only PRs where `author.login` equals the chosen login.

If a release commit references PRs from another repository, resolve those PRs in their actual repository and include that repository in `SELECTED_REPOS`. Validate each selected PR against its own repo's checks, deploy evidence, and smoke requirements. Never fetch selected PR metadata from a hard-coded repo.

## Informational automated validation

For every selected PR, in its actual repo, collect checks for context:

```bash
gh pr checks <n> --repo "$PR_REPO"
```

Report check states accurately, but do not use any check result—including failed, cancelled, pending, queued, in-progress, or skipped—as an approval blocker. Do not require reruns, waivers, or equivalent successful checks before release approval. Staging deployment containment and applicable smoke results are the approval gate.

**Named exception — `staging-failure-destinations-empty` (C-20638, post-mortem A6).** In `trycourier/backend` the `Release PR Checks` workflow reports environment state, not code health, so it *is* an approval blocker. It lists `backend-staging-SendFailureDestination-*` in `us-east-1` and `eu-west-1` and fails when any queue holds messages, printing each queue's depth and oldest-message age. A red gate means staging is still dropping sends into the failure destination: drain the backlog and fix its cause, or — only when the backlog is understood and accepted — add a line `SFD-EXCEPTION: <reason>` to the release PR body, which clears the gate and records the acceptance in the PR. Never approve a release over a red `staging-failure-destinations-empty` without such a line; on 2026-09-08 that queue sat at depth 65 for three days and release v0.1707.0 shipped the same behavior to production unnoticed.

Structural failure mode (learned 2026-09-11): the workflow checks out `pull_request.base.sha`, frozen in the event payload. When the script itself is introduced by the release being checked (or is otherwise absent at the base SHA), every run of that event exits 127 — reruns cannot help. Verify whether the script exists on the base ref before trusting a red result; when it is structural, run the queue probe manually (same regions/queues, read-only `get-queue-attributes`), state the depths, and record acceptance via `SFD-EXCEPTION:` as above.

## Required staging deploy validation

Validate staging deploy evidence in the repo that owns the selected PR, not in a hard-coded repo.

### Discover candidate staging deploy workflows

Resolve the staging deployment ref/environment from release metadata, repo docs, and workflow branch/environment filters. Set `STAGING_REF` only when the deploy chain is branch-based; omit the branch filter when it is environment-, tag-, or dispatch-based.

List workflows and runs:

```bash
gh workflow list --repo "$PR_REPO" --all
gh run list --repo "$PR_REPO" --limit 200 \
  --json databaseId,workflowName,headSha,headBranch,status,conclusion,createdAt,url,displayTitle,event
# Add --branch "$STAGING_REF" only when the discovered deploy chain is branch-based.
```

Identify staging deploy workflows from current repository evidence:

- workflow files and names containing staging/deploy/release concepts,
- branch or environment filters targeting the staging environment,
- setup/orchestrator workflows that dispatch regional or runtime-specific deploy workflows,
- repo-specific CDK, Serverless, ECS, Lambda, Kubernetes, package-publish, or migration workflows.

Do not require a workflow filename, display name, branch, region, or job that has not been discovered in the target repo.

### Match the deployed SHA

Prefer an exact successful run where:

```text
headSha == selected PR mergeCommit.oid
```

By default, do **not** block on a missing or failed exact-SHA run when a later staging head contains the selected PR merge commit and can be proven deployed to the applicable staging surfaces. Treat that later containing head as deployed evidence for every selected merge commit it contains. Verify containment with local git history when the repo is available, for example `git merge-base --is-ancestor <mergeCommit> <deployedHeadSha>`, or with GitHub compare/commit history when local history is unavailable.

Only require exact-SHA deployment if the user explicitly says later containing staging heads are not acceptable. If the repo deploy system uses setup workflows, regional runs, or runtime-specific children, follow them to identify the applicable deployed surfaces and smoke scope. Duplicate, failed, cancelled, pending, or skipped runs do not block when live staging evidence proves a containing head is deployed.

### Inspect deploy jobs dynamically

Inspect each required run:

```bash
gh run view <databaseId> --repo "$PR_REPO" --json jobs
```

Deployment evidence is repo-specific. Derive it from matched workflow definitions, run jobs, changed runtime surfaces, repository release docs, and—when available—the live staging revision, task definition, stack, or artifact identity. Use this evidence to prove that the environment being smoke tested contains each selected PR across every applicable runtime, architecture, service, stack, and region.

Workflow job states do not independently gate approval. Failed, cancelled, pending, or skipped build, test, typecheck, integration, packaging, publish, migration, orchestrator, or deploy jobs are informational when a later containing deployment or live staging identity proves the selected change is deployed. Block only when the selected change cannot be proven present in an applicable staging surface. If a user explicitly excludes an applicable region or runtime, record that as residual risk and do not claim full deployment validation.

A rerun attempt of the same GitHub Actions run is separate operational evidence only when GitHub reports a distinct `run_attempt`, the applicable jobs actually execute again, and their checked-out head still contains the selected commits. This may satisfy a requirement for consecutive staging executions or warm-cache evidence; a skipped/no-op attempt may not. Record each attempt and inspect its jobs and timing independently.

Repo-native staging smoke jobs may count as happy-path functional evidence when they run on a deployed staging head that contains the selected PRs, use staging-scoped secrets, and cover the affected feature path. Inspect the workflow/job environment and test selection before relying on them; do not treat a generic smoke job as coverage for an edge case it does not exercise.

## Mandatory planning delegation

Before manual smoke tests, use cheap-first subagents (`scout`, `context-builder`, `delegate`, or `worker`) to inspect:

- selected PR diffs and files,
- relevant code paths,
- repo-specific deploy workflows,
- staging docs and URL discovery,
- operational risks,
- available safe staging validation options.

Ask them to identify affected systems, happy paths, edge/failure paths, credentials/config needed, and residual risks. Keep this pass cheap in fact, not only in name: cap each delegated scout at eight turns, give it one non-overlapping question, and require a compressed evidence contract (paths, run IDs, scenarios, prerequisites, and gaps). Synthesize one QA plan and execute it yourself.

A subagent may recommend `blocked`, but the main agent must treat that as a proposed plan state, not the final release decision. Execute the plan and its safe unblock paths before deciding.

Escalate to a deeper reviewer/planner only if the cheap pass is inconclusive or release risk is high.

## Execution-before-blocking patterns

Use these patterns when ordinary API smoke or naturally occurring logs do not exercise the changed behavior.

A failed validation harness is not evidence that the product failed. Classify each failure before deciding:

- **product failure:** the request reached the intended deployed surface and the changed contract failed;
- **prerequisite failure:** credentials, fixture, endpoint, or deployed identity could not be proven;
- **harness failure:** the probe targeted the wrong surface, asserted the wrong protocol/schema, or failed before interpreting product evidence.

Do not issue a terminal blocker while authorized safe evidence recovery remains. Correct only proven zero-effect harness failures within the current authority envelope; after any effect, preserve the evidence and require the governing attempt policy or fresh owner authority rather than silently replaying a write.

### Test the behavior this release can actually enable

- Derive live modes, flags, aliases, parameters, and dependencies from the deployed staging runtime.
- If a selected change is intentionally inert and its enabling adapter/configuration belongs to a separate, unmerged, or separately approved release, test the current configured behavior end to end and test the dormant core in isolation where useful.
- Do not make a future enabled path a blocker when this release cannot activate it, the live configuration keeps it disabled, and activation has its own explicit deployment/approval gate. Record that path as deferred/N/A and name the owning dependency.
- Never merge or deploy an unmerged dependency merely to satisfy release validation. The tested release scope remains authoritative.

### Exact-SHA isolated staging probes

An isolated probe may provide functional staging evidence for shared libraries, failure handling, rollout controls, or observability when no safe public API reaches the branch:

1. Build the probe from the accepted deployed staging SHA, not from an arbitrary local branch.
2. Use a temporary, uniquely named staging Lambda/job/container and least-privilege role. Deny or omit only the permission needed to produce the intended failure; never weaken an existing runtime role.
3. Bind reads and writes to exact synthetic resources. Keep customer resources and append-only/dense state outside the probe boundary.
4. Exercise every changed operation and assert both the returned failure/success behavior and the emitted log/metric schema. Check for forbidden raw values, error details, tenant IDs, message IDs, and secrets.
5. For cache/kill-switch behavior, keep the same warm execution identity when that is part of the bound, measure first-zero latency, and verify a second zero-selection period.
6. Pair the probe with an end-to-end smoke of the actual deployed runtime in its live mode; a probe does not prove application wiring by itself.
7. Delete the temporary compute, role/policy, log group, and synthetic parameters/records in `finally`, then independently verify absence.

### Controlled configuration and synthetic API writes

- Start from a fail-closed baseline, publish the synthetic document before its digest/activation marker, and publish the stop marker before cleanup.
- Use a staging-only tenant and reserved recipient domains such as `example.com` or `example.invalid`; verify send acceptance, downstream retrieval/state, regional behavior, and archive/cleanup or documented retention.
- Retrieve staging credentials without printing them, verify the AWS account/stage first, and keep identifiers out of the final report when the runbook requires secrecy.
- For `trycourier/backend` `/send` smoke, mint a dedicated staging token (`dynamodb put-item` on `${PREFIX}-tenant-auth-tokens`) — a Lambda's `COURIER_AUTH_TOKEN` is the production credential, not a staging inbound credential. Full procedure and pitfalls: workspace `docs/staging-auth-and-release.md`.
- Validate observability from the changed artifact itself: parse raw EMF/log envelopes and confirm the backend (for example CloudWatch or Datadog) received the expected namespace, metrics, dimensions, and safe properties.

## Comprehensive smoke matrix requirements

For each selected PR, classify whether manual smoke is required.

Manual smoke is required for changes to:

- runtime behavior,
- infrastructure/deployment/workflows,
- persistence,
- queues/streams,
- auth/permission boundaries,
- APIs,
- background workers,
- external integrations,
- observability or event/log schemas.

Usually no manual smoke is required for docs-only, tests-only, pure refactors with no deployed behavior, or build metadata with no staging runtime effect. Still explain why.

For every runtime-impact PR, cover:

- happy path,
- important edge cases introduced or protected by the change,
- failure/rollback paths when safely testable,
- regional impact when applicable,
- persistence/idempotency/conditional write behavior when applicable,
- queues/streams/background worker processing when applicable,
- auth/permission boundaries when applicable,
- observability/log/event-shape changes when applicable,
- deployment/configuration/package-loading risk when applicable.

Health checks and log scans may support the result, but they do not replace functional validation. If the exact expected log line is suppressed by staging log level, sampling, or metrics configuration, use stronger proxy evidence only when it is tied to the behavior under test: trigger the behavior with synthetic identifiers, observe downstream processing/state transitions, confirm absence of expected error/failure logs, and cite unit/integration coverage for the suppressed branch. Record the logging gap as residual risk instead of pretending the exact log was observed.

## Staging validation guidance

Use the target repo's staging/release docs if present. Common locations include:

- `<repo>/docs/staging-auth-and-release.md`
- `<repo>/docs/**/staging*.md`
- repo deployment config under `.github/workflows`, `cdk`, `serverless`, `apps/*/cdk`, or service-specific docs

If docs are absent, resolve URLs/config from SSM, Lambda/ECS/CDK configuration, GitHub workflow environment, and repo deployment config.

Before any product call, build a typed endpoint inventory for the selected behavior. At minimum distinguish credential/debug endpoints, the deployed service REST endpoint, GraphQL/compatibility endpoints, publish APIs, legacy WebSocket endpoints, replacement/service WebSocket endpoints, and region-specific variants. Record each endpoint's owning runtime and source of truth. An environment variable named `API_URL`, `BASE_URL`, or similar is not proof that it is the target service endpoint: inspect its consumer and prefer the owning stack's live CloudFormation/CDK/Serverless output. Fail before writes when two endpoint roles remain ambiguous.

Use AWS with explicit staging profile and region:

```bash
AWS_PROFILE=staging aws ... --region us-east-1
AWS_PROFILE=staging aws ... --region eu-west-1
```

Credentials and configuration can often be discovered without exposing secrets:

- `gh secret list --repo <repo>` can confirm secret names exist, but GitHub does **not** reveal secret values. To use those secrets, rely on a workflow job that consumes them or ask for equivalent staging credentials.
- AWS Lambda/ECS task definitions, SSM, Secrets Manager, and CloudFormation outputs can reveal staging endpoints, env var names, and sometimes runtime-injected secret values to the current AWS principal. Never print secret values in the report; only report presence, source, length, or redacted identifiers.
- Existing repo workflows may already run with the needed staging secrets. A successful workflow smoke job can be evidence when its checked-out SHA contains the selected PRs and the test path matches the PR behavior.

Prefer read-only checks where they fully validate behavior. If writes are necessary:

- use clearly identifiable smoke data,
- avoid customer data,
- use a safe staging tenant/API key,
- verify the resulting state,
- clean up when applicable.

If required credentials or safe test data are missing, ask for them or block. Do not approve based only on deploy health.

## Synthetic validation and cleanup

When a runtime behavior cannot be validated by an existing staging smoke job or safe public API call, a controlled synthetic test is acceptable if it is specific to the PR behavior and low impact.

Keep one durable campaign ledger across preflight, effect, evidence, and cleanup phases. Record product-call and write-attempt bounds, confirmed mutations, unknown effects, corrected zero-effect retries, cleanup state, exact endpoint roles, and evidence references. Continuation scripts and post-run reads must update the same counters instead of resetting them. Empty or absent CLI JSON responses must be parsed defensively before they can influence an effect decision.

For synthetic AWS/service tests:

- derive stream, queue, table, bucket, function, cluster, endpoint, and feature-flag names from staging config instead of hard-coding production names,
- discover CloudFormation stacks by current outputs/resources rather than inferring a stack name from a repository or project name,
- use unique identifiers such as `<feature>-qa-<timestamp>` in every record, key, message, and log query,
- avoid customer tenants, customer payloads, and real recipients,
- use the same key prefixes, partition keys, serialization formats, and delay semantics as production code; inspect the implementation before writing synthetic records,
- when completeness depends on activation epochs or watermarks, first establish post-activation synthetic coverage and advance every applicable watermark beyond the selected window end,
- verify the intended downstream state transition, queue/stream processing, logs/metrics, and absence of unexpected errors,
- delete synthetic locks/rows/files/messages where supported, and verify queue depths or TTL/cleanup behavior when deletion is not possible,
- record any temporary delayed messages, TTL-backed rows, or expected low-impact residue and confirm they drained or will expire.

### Controlled fault injection and recovery

Use controlled staging fault injection only when a required failure path cannot be validated with an existing safe fixture or staging API.

- Obtain explicit user or release-owner authorization before injecting a fault that intentionally degrades staging behavior or writes malformed operational state.
- Inspect the storage/ordering model first. Choose a fault outside dense counters, append-only chains, immutable manifests, checkpoints, or customer-visible state whenever possible.
- Never corrupt an append-only or dense-position object unless the repository runbook defines an exact, proven recovery procedure for that object.
- Use a uniquely identifiable, collision-checked staging-only fault and wrap cleanup in `try`/`finally` or a shell trap. Cleanup must target only the exact synthetic object.
- Prove the failure end: expected nonzero result, allow-listed sanitized reason, and absence of any success artifact that must not be written.
- Prove the recovery end: fault object absent, queues/streams/workers healthy, and a fresh end-to-end smoke returning the normal successful result. Cleanup without a successful recovery run is not sufficient.
- Never run staging fault-injection procedures in production. Never publish object keys, report paths, payloads, run identifiers, or digests.
- Do not infer that no recoverable fault exists solely because the application has no public fault endpoint or no natural error appears in logs. First evaluate an exact-SHA, least-privilege isolated probe that cannot affect existing runtimes or customer state.
- If an isolated probe or controlled write is feasible but not yet authorized, request authorization and pause the decision; do not issue a final blocked result before the user can authorize it.
- If no recoverable fault can exercise the required scenario after that evaluation, or authorization is declined, block approval rather than improvising a destructive test.

## Observability and Datadog validation

For observability changes, validate the artifact that changed, not only application health:

- Read the repository's metric/log wrapper before asserting names. A constructor or caller label may be stored as a property while the backend namespace is derived from the runtime or function name. Parse the raw envelope, identify the actual namespace, metric, dimensions, and caller properties, then confirm backend ingestion using those exact fields.
- For Datadog, prefer the local `pup` CLI when available (`pup auth status`, `pup monitors get <id> --read-only --output json`, `pup logs/metrics ...`).
- Verify monitor/dashboard/log-query IDs, names, query text, tags, state, and links from the runbook or PR.
- If Datadog credentials are unavailable, ask for access or report the monitor/dashboard validation as blocked/residual risk; GitHub secret names alone are not enough evidence.

## Example send-pipeline/provider-render coverage

For send-pipeline/provider/message/event-log/provider-render changes, comprehensive validation usually requires a real or controlled staging send plus state inspection:

1. Submit a staging smoke message through the relevant API/path using a staging tenant key.
2. Exercise at least one successful provider path affected by the PR.
3. Exercise an important safe failure or validation edge path when applicable.
4. Verify message status transitions and channel/provider fields in MessagesV3/Dynamo.
5. Verify provider event logs (`provider:sent` and/or safely generated `provider:error`) have expected shape and correlation fields.
6. Check Kinesis/Firehose/Lambda/SQS or downstream stream processing when the PR touches those paths.
7. Check coordinator/sender/provider-render logs for provider dispatch, module resolution, conditional writes, throttling, fallback behavior, and unexpected errors.
8. Validate both US and EU where the changed service is regionally deployed or region-specific.
9. For lock/idempotency changes, seed only synthetic locks or records, using the exact storage key prefix/namespace used by the service implementation, then verify delayed/retry/stale/drop behavior through downstream workers and absence of provider-work errors.

## Example packaging/deploy coverage

For dependency, package-loading, Lambda, ECS, or ARM64 packaging changes:

- staging deploy job success for every affected runtime/region is required,
- check affected Lambdas/ECS services are on the expected staging revision and stable,
- inspect fresh task/function logs for `MODULE_NOT_FOUND`, startup crashes, init errors, and repeated restarts,
- hit service health endpoints for affected services when available.

## Example CLI/tooling coverage

For non-service tooling such as `egress-shadow-comparator`:

- run targeted unit tests for changed matching/correlation behavior,
- run the CLI against fixtures or safe staging data if the CLI is part of release risk,
- validate both happy matches and mismatch/invalid-correlation edge cases.

## Decision

Approve when every selected PR is proven present in the staging deployment under test and every applicable comprehensive smoke scenario passes. PR check results are informational and never block release approval. Historical failed or cancelled deploy runs also do not block when a later deployed staging head contains the selected commits and the applicable smoke scenarios pass.

Do not carry an earlier blocked summary forward after additional authorization or evidence arrives. Resume the workflow, run the newly authorized scenarios, verify cleanup and current deployment identity, and make a fresh decision from the complete evidence. A scenario that belongs to a disabled future activation is not automatically applicable to the current release; applicability follows the deployed configuration and the dependencies included in the release.

Approval command:

```bash
gh pr review <release> --repo "$REPO" --approve
```

Do not add `--body`, `--comment`, or any PR comment/review text for release validation approval unless the user explicitly requests comment text. If instructions conflict, prefer the no-body approval command above over any user-provided template that includes `--body`.

If a selected PR is not proven deployed to staging, an executed applicable smoke scenario fails, or a required scenario still cannot be executed safely after discovery and any authorization request, do not approve. Return a blocked summary with the attempted validations, exact smoke/deployment blockers, declined or unavailable prerequisites, and residual risks. Never use "not yet tested" as the final blocker when a safe authorized test remains available.

## Required output

- Release PR URL
- Repository used for release PR
- Author used
- Selected PR list, including each PR's repository
- Per-PR check/deploy status
- QA plan summary
- Smoke tests run and results, mapped to PRs and scenarios
- Untested scenarios and residual risks
- Final action: approved or blocked

## Lessons 2026-08-25

- Release approval requires an authenticated functional smoke through the affected production-impact
  path. A production-only flag that remains inert and a readback showing that inertness are vacuous
  for functional behavior; they prove only safe inactivity, not that the release path works.
- The `sync-release-author-approvals` gate must cover every included PR author. If a teammate closes and
  re-cuts the release PR, selected commits and required approvals can change or reset; re-arm monitors,
  recompute the author set, and revalidate the replacement release PR.
- Use merge-commit-only delivery. A `BEHIND` release/feature state requires rebasing onto the current
  base before proceeding; the repository's carried approval remains valid after that rebase, while
  ordinary exact-head checks still need to pass.
