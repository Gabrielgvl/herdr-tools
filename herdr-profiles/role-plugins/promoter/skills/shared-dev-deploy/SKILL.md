---
name: shared-dev-deploy
description: >-
  Deploy safely to the shared Courier development environment. Use before any Backend or Services
  dev deploy, when the engineering-dev-env lock is held, when more than one lane needs the dev stack,
  when creating a deploy worktree, when SLACK_BOT_TOKEN or COURIER_AUTH_TOKEN is absent, or when an
  ARM64 image build or transform run is involved.
---

# Shared Dev Deploy

This skill is the authority for the rules below. Deterministic blockers for QEMU cross-arch builds,
local Services `cdk deploy`, and multi-function/full deploys are enforced by
`.policies/preflight-check.mjs`; everything else here is followed by reading it.

## Serialize the shared stack

1. Obtain a manager-granted dev deployment slot. Serialize deployments to one shared dev stack at a
   time; do not let independent workers deploy concurrently.
2. Read the `#engineering-dev-env` lock and compare its resource scope with the proposed deploy.
   An overlapping lock blocks. A proven non-overlapping lock does not. Missing or ambiguous scope
   means wait and report; do not guess.
3. Dev and staging permit the mutation classes needed for their authorized validation. This does
   not authorize production, unrelated resources, or a broader shared-stack deploy.

## Start from an authoritative base

- Create the deploy worktree from fetched `origin/staging`, not a stale local ref. Before any deploy,
  record the worktree HEAD and fetched base and verify their relationship with `git merge-base`.
- If fetch, fork, base identity, ancestry, or the intended revision is ambiguous, stop before the
  deploy. A stale-base deploy previously removed an export construct.
- Validating unmerged work is the exception to "create from `origin/staging`": deploy the exact
  branch head (`deploy-dev.yml --ref <branch>`). Merge order is a plan decision, never a technical
  prerequisite for a dev deploy — never defer a dev run waiting for merges.
- When the work spans several branches, build one dev-only integration branch (cherry-picks allowed,
  labelled as such in its commits, never merged, never a review surface), deploy that head, and
  record it in the evidence. Every reviewed PR still travels its own path.
- Keep the deploy footprint to the changed function/project. A full stack is not the default.

## Use the minimum-footprint path

- Backend deployment commands and target-worktree rules live in [backend-deploy](../../../backend/.agents/skills/deploy/SKILL.md).
  Its single-function path is the default; `full_deploy.sh` requires explicit owner authorization
  each time and must not become a de-facto full deploy.
- Services DEV ARM64 image builds follow [services-arm64-migration](../services-arm64-migration/SKILL.md),
  which owns the exact-branch workflow, native-architecture builder, no-QEMU rule, and local-CDK exception.

## Resolve credentials without exposing them

Resolve secrets in this order only: SSM, local config, then the sanctioned bundled fallback. Keep
values in process environment only; never print, log, commit, or place them in a brief or evidence.

- When `SLACK_BOT_TOKEN` is absent, resolve it from the dev account with:
  `aws ssm get-parameter --name slack-bot-token --with-decryption --region us-east-1 --query Parameter.Value --output text`
  then local config, then the backend script's sanctioned bundled fallback. This applies to
  Services `scripts/devlock.sh` and Backend deploy scripts; stop only when all three sources fail.
  An absent environment variable is not itself a stop.
- An absent `COURIER_AUTH_TOKEN` is not itself a stop. Resolve it from the `/dev-config` SSM
  namespace using the repository's approved key/provenance. For synth-only work that never reaches
  AWS, a nonblank placeholder is sufficient.

## Protect the host and deployed config

- Before a construct redeploy, rotate `configDigest` inputs (role suffix and CMK); stale environment
  reuse can produce `EXPORT_SESSION_REJECTED`.
- Transform runs require at least 32 GB free. Cap test parallelism at `--maxWorkers=4`; use a
  trap-based pause/restore for the owner's local-llama-chat service when the run requires it.
- Treat explicit `tableName` plus `RETAIN` as an orphan trap. Verify the table is empty and the stack
  is absent before cleanup, using the approved Pi lane for any cloud inspection.
- After deployment, verify the exact target revision, account/region, stack status, and representative
  smoke result. Stop on drift, lock ambiguity, credential ambiguity, or unhealthy infrastructure.

## Lessons 2026-08-25

- `deploy-dev.yml` acquires the project devlock itself. Release the project lock before dispatching
  `RUN_ON` or `RUN_OFF`; never hold it across a workflow dispatch or CI deploy. Take the lock only for
  local operator verbs and their bounded readbacks, then release it before the next workflow run.
- Throwaway deploy-only branches are still subject to `affected:test` and guard tests before deploy.
  Keep the affected test green: use a narrowly scoped, owner-authorized throwaway override or a flag
  path the guard does not assert, never silently weaken the permanent test suite, and verify the branch
  contains only the intended deploy-only change.
- A dev EC2 transform host costs about $2/hour. `RUN_OFF` is mandatory after the rehearsal, with a
  terminal-success readback proving the host and bundle outputs are gone; do not leave the host running.
- Concurrent dev deploys for one project collide on the shared stack. Serialize them through the manager
  and wait for the prior workflow and readback to reach a terminal disposition before dispatching another.

## Lessons 2026-09-03

- **The single-Lambda dev deploy path is code-only.** It cannot add or change environment bindings. A PR whose evidence needs new env keys (e.g. epoch readers) requires ONE exact-head full-stack deploy with explicit owner authorization — plan it up front instead of discovering it at the lane's STOP (A1 #10155, 22:07Z).
- **Install before the devlock.** A fresh detached deploy checkout has no `node_modules`: run the repo install (`yarn install --frozen-lockfile`, Node pin per repo) and verify the Serverless CLI resolves (`yarn serverless --version`) BEFORE taking the lock; the first A1 attempt held the lock 7 s and exited on a missing CLI.
- **Full deploys reset others' work.** Every full shared-dev deploy replaces all per-Lambda dev deploys made since the previous full deploy (twice today: 15 Lambdas, then 175 from another team's full deploy). List them before deploying (`yarn check-dev-deploy` or LastModified newer than the stack's LastUpdatedTime) and name them in the devlock announce and the evidence.
- **Per-record smoke criteria.** One synthetic API send fans out to one render record per route address (primary/failover); write smoke criteria as "exactly one shadow computation per record and zero second effects by the new path", not "one record" (C-18965, 14:34Z stop).
- **Carry-forward has a boundary.** Dev evidence carries across a rebase only if the smoked surface did not change substantively; a rebase that merges a sibling's code into the smoked worker is an owner call, not a manager assumption.

## Lessons 2026-09-04 — three false greens and the long-deploy rule

Each of these returns success or silence while doing nothing, which is the dangerous shape on a shared stack.

- **`services/scripts/devlock.sh run` needs the command as `argv[0]`.** An `export VAR=…;` or `env VAR=… cmd` prefix after `run` makes it either skip the lock and announcement entirely ("skipping lock check/announcement") or execute nothing at all and return 0 — the wrapper runs `setsid` on the command array. **Set every environment value inside a wrapper script and pass that script as the command.** Reproduced with a trivial probe: `-- bash probe.sh` prints; `-- env FOO=bar bash probe.sh` prints nothing, exit 0.
- **The Backend full-deployment script's interactive confirmation exits 0 silently with no TTY.** An agent lane gets zero output, zero effect and a success code. Pass the script's force flag from any non-interactive lane; the owner's ledgered authorization is the confirmation of record.
- **Never hand-parse `.dev-config.yml`.** Several values carry trailing inline YAML comments; a `startsWith`/`split` parser produced a 146-character token where the real value was 28, the API authorizer missed it, and the lane reported the dev credential as *stale* — a wrong owner-facing claim that had to be retracted. Parse with js-yaml (or `yq`), never string surgery. Related trap already known: `COURIER_API_GATEWAY_ID` in that file genuinely does not match any API in the dev account; resolve the endpoint independently.

**Long deployments must be detached.** The agent harness kills a lane's background task at roughly twenty minutes; one full dev deployment died mid-packaging (verified zero AWS effect: stack `LastUpdatedTime` unchanged, no non-terminal stacks, target functions at baseline). Run the deployment as a detached process (`nohup setsid` on a wrapper that sets its own environment) started through the lock wrapper, then **poll the log and the stack from fresh tool calls** — never hold one call open across the CloudFormation update. A client-side kill mid-update is the real unknown-effect hazard; detaching protects the stack while leaving the operator able to stop it by PID or `cancel-update-stack`.

**Zero-effect proof is the retry precondition.** After any interrupted attempt, prove `effectStarted=false` before a corrected retry: stack status and `LastUpdatedTime` unchanged, no stack in a non-terminal state, no deployment process alive, target functions still at their pre-attempt `LastModified`/`CodeSha256`, lock released. A retry on that evidence consumes no additional owner authorization.

## Lessons 2026-09-06 — the resolved-environment budget

- **Measure the resolved Lambda environment, not the source YAML.** The guard that matters is
  `Σ len(key)+len(value)` over the *resolved* `Environment.Variables` against Lambda's 4,096-byte
  limit. A source-byte check on the YAML block is a proxy that moves in the wrong direction: deleting
  a function-local empty override *shrinks* the source text while *restoring* the inherited provider
  value and growing the deployed environment.
- **Dev understates staging and production.** Measured 2026-09-06 on the ProviderSend path:
  `ProviderSendQueueWorker` dev 3,450 B, production 3,666 B, staging over 4,096 B with the same PR
  applied. Read staging and production with `aws lambda get-function-configuration --query
  Environment.Variables` (or `serverless print --stage <stage> --region <region>` where credentials
  allow) for every function the change touches, and keep ≥ 300 B of margin. Report key counts, byte
  totals and presence booleans only — never a value.
- **Retire only keys the deployed code cannot read.** Cite the grep over the function's import graph
  per key. An empty function-local override of a provider-level key is not a retirement candidate.

## Lessons 2026-09-09 — the env-noop guard (C-20644 / A14)

- **`deploy_lambda.sh` used to silently no-op an intended env change.** `serverless deploy function`
  drops the *entire* `Environment` block when any resolved value is a CloudFormation intrinsic
  (`node_modules/serverless/lib/plugins/aws/deploy-function.js:335-336`), printing "Function
  configuration did not change" instead of failing — a 2026-09-08 dev deploy with exported
  `PROVIDER_SEND_TRANSPORT`/`_EPOCH` shipped code but left the env untouched. `deploy_lambda.sh` now
  detects that shape (an intrinsic present + an exported var differing from what's deployed) and
  fails loudly, naming the variable(s) and pointing to `full_deploy.sh` or a direct
  `aws lambda update-function-configuration`; `--allow-env-noop` bypasses it deliberately. The dev
  drift this caused on 2026-09-08 (8 functions) stands until C-20606 fixes the underlying defaults.

## Lessons 2026-09-10 — single-app ARM64 dispatch and the `skip_tests` guard
- When the AMD64 `deploy` job is broken by another team's app (C-20715: an arm64 image built in the AMD64 lane), deploy one arm64 app alone: `gh workflow run deploy-dev.yml --ref <branch> -f deploy_amd64=false -f deploy_arm64=true -f arm64_project=<app>`; the shared `nx deploy config` step of the failed run has usually already landed — check its log before assuming.
- `skip_tests=true` needs `tests_green_run_id` whose RUN conclusion is `success` on the exact head; a run with green tests but a failed deploy job is rejected by `verify-skip` — rerun with tests (≈ 25 min) instead of retrying the skip.
- Pi lanes running `git fetch`/`push` inside background shells can hang on SSH indefinitely; briefs wrap network git in `timeout 120` and report a block instead of looping.
