---
name: courier-pr-gates
description: "Decide the review, approval, merge, and rebase gate for a Courier PR: risk tier, /claude-review versus human approval, rebase approval state, single-commit check, pi-review round ceiling, release hold, auto-merge."
---

# Courier PR Gates

This skill is the authority for Courier PR gates. Two of its rules are also deterministic
`.policies/preflight-check.mjs` blockers — bodyless approvals and the staging base for feature PRs —
and are stated below; the rest hold because you read them.

## Non-negotiables the preflight hook also blocks

- **Approvals carry no body.** Submit a GitHub PR approval with no review body. Never pass
  `--body`/`--body-file` (`-b`/`-F`) to `gh pr review --approve` unless Gabriel asked for a body on
  that specific approval, which is injected as `PREFLIGHT_GITHUB_APPROVAL_BODY_AUTHORIZED=1` plus
  `PREFLIGHT_GITHUB_APPROVAL_BODY_PR=<number>`. Non-approval reviews (comment/request-changes) may
  carry a body.
- **Feature PRs target `staging` on Backend and Services.** Only `release-*` and `hotfix-*` branches
  may target `main`; `main` auto-deploys to production, so a feature PR based on `main` is a misroute
  that must be retargeted before merge.

- **A side PR never carries another ticket's id in its title.** Linear's GitHub automation closes the
  ticket named in a merged PR's `[TICKET-ID]` title prefix: on 2026-09-04 the resource-trim PR #1718,
  titled `[C-20330]`, moved E-01's C-20330 to Done while the real E PR #1715 was still draft. Title a
  side PR with its own follow-up ticket id (file one with AC if none exists); mention the parent only in
  the body as `Part of <id>`. Never write `Closes <id>` for a ticket the PR does not fully deliver.

## Map risk to the required gate

- **Green or yellow:** obtain the required current-head Claude approval; do not add or wait for a
  human approval solely because the tier is green/yellow. For yellow, a passing `/claude-review` is
  the review gate. On Backend, the `/claude-review` bot approval satisfies the yellow required-review
  gate.
- **Orange or red:** require the human approval required by the repository's live policy. Do not
  replace a required human gate with `/claude-review`.
- **A PR must be out of draft before any human approval is requested — always** (owner rule
  2026-09-09). Run `gh pr ready <n>` first, then ask; never route an approval request on a draft, and
  never report `NEEDS-HUMAN-APPROVAL` while `isDraft` is true. Post-mortem/tooling PRs the owner has
  ruled yellow/green get the full standing close-out (READY → `/claude-review` → auto-merge arm)
  regardless of a path-based `risk:red` label; the label stays, and auto-merge waits if the ruleset
  still wants a human review.
- A `system-courier` approval is not a route you can take — see **Approval routes per risk tier**
  below. If one is already present on the PR, read it as the approval the ruleset accepts; never plan
  around obtaining one.
- Changes under `libs/messages` carry the Services human engineering-team gate; `/claude-review`
  does not satisfy that gate.

## Apply repository gates

- Mark the PR **READY** before requesting `/claude-review`. Draft PRs can silently produce zero review objects; a successful-looking request without a review object is not a gate.
- Verify that at least one Claude review object exists and that its `commit_id` equals the exact current PR head. A missing, failing, or stale Claude gate never arms auto-merge.

- Services PRs need CI, one pi-review round, and `/claude-review`; add the engineering-team human
  gate for `libs/messages` paths.
- Backend yellow PRs need passing CI and the current-head `/claude-review` approval. Higher-risk
  Backend tiers retain their repository-defined human gate.
- Keep the review tied to the exact current head, base, required checks, threads, and mergeability.
  A stale, dirty, or behind PR is not merge-ready.
- Treat the 800 changed-source-line limit as a best-effort budget. If cohesion or reviewability
  justifies an exception, record the reason in the PR instead of silently splitting semantics.

### Review-command deadlock

Bound every `/claude-review` wait. At timeout, stop polling and offer exactly: use the required human
review route, remain Draft and blocked, or obtain owner authorization to mark READY with auto-merge
disarmed and retry once. READY only enables review; without current-head approval it never authorizes
or arms a merge.

## pi-review round ceiling reached (owner decision 2026-09-04)

Three total pi-review rounds is the ceiling. On reaching it:

- Apply only the fixes for findings confirmed in round three, then stop reviewing. There is no fourth
  round to buy: pi-review removed `--override-round-limit`, spends nothing at the ceiling, and returns
  `BLOCKED`/exit 1 (see `herdr-manager` §6 and `pi-review-pr`).
- Keep the round-three accounting as it stands: a `BLOCKED` report stays `BLOCKED` in the PR and the
  handoff. Never restate it as PASS or as a satisfied pi-review gate.
- Record the remaining pi-review gate as **explicitly owner-waived by this decision** — attributed to
  the owner, naming the PR, the round-three head, and the confirmed findings fixed — then continue the
  workflow to the PR's other gates. The waiver is automatic (owner ruling 2026-09-06): do not ask the
  owner again at the ceiling.

The waiver is this narrow or it does not hold:

- Only findings confirmed in round three are in scope. Findings surfaced later, unrelated refactors,
  and other tickets' scope are out — file them as follow-ups.
- Only the pi-review gate is waived. CI, the current-head `/claude-review`, the orange/red human
  approval, the `libs/messages` engineering-team gate, and thread resolution all still run on the final
  head; `/claude-review` is what reviews the round-three fixes.
- Any branch change beyond those fixes voids the waiver — that surface has been reviewed by nothing, so
  re-establish the review gate before merging.

## Rebase, approvals, and single-commit branches

- A conflict-free rebase does not require reapproval when the approved change remains the same and
  repository policy preserves that approval.
- A conflicting rebase, changed review surface, dismissed approval, or stale current-head review
  requires the repository's review again. See the **Stacked-PR babysit rule** in `herdr-manager`:
  freeze the parent during dependent work; never arm `--auto` against a PR branch; merge parent first,
  let GitHub retarget the dependent to trunk, then rebase it to one commit with a patch-id check before
  arm → approval (identical smoke evidence carries forward). Restacking dismisses dependent approval.
- For a repository enforcing one commit, update by rebase, not GitHub's Update branch action:
  `git fetch origin staging`, rebase the single commit onto the fetched base, then publish with
  `git push --force-with-lease`. A merge commit fails the single-commit gate.

## Rebase changed the patch-id

`git patch-id --stable` can flip from context-line drift. Before calling it a content change, compare
only added/removed lines from each one-commit patch:

```bash
git diff <old>^ <old> | awk '/^[+-]/ && !/^(\+\+\+|---)/' | sort > /tmp/old.lines
git diff <new>^ <new> | awk '/^[+-]/ && !/^(\+\+\+|---)/' | sort > /tmp/new.lines
cmp /tmp/old.lines /tmp/new.lines
```

## CI never ran on this head

Use `gh run list --branch <head-branch>` and verify a `Backend PR Workflow` run exists for the exact
head. If none registered, close/reopen the PR to fire `pull_request: reopened`; fallback to
`gh workflow run backend-pr.yml --ref <branch>`, noting that dispatch may not bind required checks.
After any trigger, re-verify draft state, approvals, exact head, checks, and auto-merge state.

## Release cut

Backend release PRs are cut by `automatic-release-pr.yml`: schedule `30 16 * * 1-4` (13:30 BRT,
Monday–Thursday), or `workflow_dispatch` with `release_type=minor|major`. They are authored by
`system-courier`; validate them with `release-pr-validation` and apply its author-scoped gate.

A backend release PR carries one extra required gate: `Release PR Checks / staging-failure-destinations-empty`
(`.github/workflows/release-pr-checks.yml`, C-20638 / post-mortem A6). It runs on `release-*` heads onto
`main` and fails when any `backend-staging-SendFailureDestination-*` queue in `us-east-1` or `eu-west-1` is
non-empty, printing depth and oldest-message age. Unlike the code checks above this one is not waivable by
judgement: either drain the staging backlog and fix its cause, or add `SFD-EXCEPTION: <reason>` on its own
line to the PR body — the gate re-runs on the `edited` event, so the description edit alone clears it with
no push. Do not arm auto-merge on a release PR while this check is red and unexplained.

Observed 2026-09-15 (v0.1711.0):
- The workflow arms auto-merge on the release PR itself, under the `system-courier` identity; lanes never arm it.
- Any later `workflow_dispatch` refreshes the open PR in place to the new staging head and **dismisses every approval**; approvals must be re-given on the new head. A lane's "exactly once" approval can therefore end up dismissed and gating nothing.
- `release-author-approvals` requires every human **commit-author email** in `main…staging` (mapped by `author-map.json`): a squash-merged PR requires the original author, not the merger. The requested-reviewer list can include people the gate does not require.
- After merge, `setup production workflow` runs on the `main` push and the two regional production workflows fire by `workflow_run`; ~25 min to both regions green. Those regional runs carry the default branch's `head_sha` (staging), not the merge commit — identify them by display title and by starting seconds after the setup run.
- `gh run list` sorts by `createdAt`: a re-run (attempt 3) of an old production run is invisible unless sorted by `updatedAt`, and it is a full redeploy of that old ref. `emergency-rollback.yml` takes an S3 artifact path, one region per dispatch, behind a Slack approval; nobody has documented the artifact path convention.

## Replying to review threads

Reply with `gh api -X POST repos/<o>/<r>/pulls/<n>/comments/<top-level-comment-id>/replies
-F body=@file` (capital `-F`; lowercase `-f` sends the literal string), or GraphQL
`addPullRequestReviewThreadReply`. Resolve addressed threads with GraphQL `resolveReviewThread`;
the staging ruleset requires every thread resolved.

## Production env-flag cutover

Use the attended CloudShell ceremony GET → merge → PUT with `--revision-id` preconditions on both
consumers within minutes, then put the env change in the **very next release**. A release with the
flag unset reverts the cutover and creates a loss window.

## Arm and hold the merge

- Routine gate execution is manager authority: do not ask for per-PR permission to request the
  prescribed review, mark READY, rebase safely, or rerun a verified transient CI failure. After every
  required exact-current-head gate passes, immediately mark the PR READY if needed and invoke the
  repository-approved auto-merge command without another owner prompt. This standing approval never
  authorizes a direct/admin bypass. Ask only for critical scope/cost changes,
  production/irreversible/high-blast-radius actions, security-policy trade-offs, or governance
  exceptions.
- Once a PR is genuinely ready, arm auto-merge immediately with the repository-approved merge mode,
  using the handoff command shape `gh pr merge --auto`. On a CLEAN PR this can merge immediately,
  rather than merely arming a request.
- After the command, re-read `state`, `mergedAt`, `autoMergeRequest`, the exact head, and required
  checks before reporting whether the PR is armed or already merged.
- Release PRs use a draft hold as the durable hold. The release approval synchronizer can re-arm
  auto-merge after every push or review event; do not treat disabling auto-merge as a durable hold.
- Before merging, recheck head/base, required checks, review freshness, threads, and mergeability.
  If any predicate drifts, stop and rebuild the packet; never force an admin/direct/squash/rebase
  merge to bypass the gate.

## Author-authored red PRs: who can approve

GitHub refuses a PR author's own approval. For orange/red PRs the owner authored, the human gate is
a **teammate** (e.g. scarney81, GateauXD); plan their availability, request their review when the PR
is READY, and re-request after every push — `dismiss_stale_reviews_on_push` drops the approval on
each rebase/amend, so sequence pushes to land before the approver acts. Never ask the owner to
"approve" their own PR (2026-08-26: asked twice; the clicks were never theirs).

## Babysit must watch CI, not only merge state

An approved, armed PR can sit `BLOCKED` for an hour on a red `test (N)` while merge-state polling
shows nothing new. Poll `statusCheckRollup` (or `gh pr checks --required`) and alert on
`FAILURE`/`CANCELLED` for the current head; read the failing job's `--log-failed` and classify
PR-caused vs flaky/infra before acting.

When a sibling merge adds or removes a CloudFormation include, every open PR carrying a pinned count
can go red until its count is recomputed. Schedule recomputation in the babysit round instead of
waiting for approvals (2026-08-27: #10099 stayed red for 2.5 hours after #10034 merged).

## Resource-count pins when adding CloudFormation includes

Several specs pin the `resources:` include count per regional file (e.g.
`send/worker/provider-send/__tests__/serverless-config.spec.ts`, `send/worker/schedule/__tests__/
serverless-config.spec.ts`). Adding an include breaks every pin, not only the one in your PR: grep
`--include=*.spec.ts` for the pinned numbers and compute the new counts from the YAML
(`awk '/^resources:/{f=1} f' serverless.yml | grep -c '^\s*- \${file('`) — never assert them.

## Diagnose an approved-but-BLOCKED PR (Backend `staging` ruleset)

An approved PR with green checks and auto-merge armed can still sit at `mergeStateStatus: BLOCKED`.
Legacy branch protection (`gh api repos/<o>/<r>/branches/staging/protection`) shows nothing — the
gates live in **repository rulesets**: `gh api repos/<o>/<r>/rules/branches/staging`. As of 2026-08-25
the Backend `staging` ruleset requires, in this order of likelihood when BLOCKED:

1. **Every review conversation resolved** (`required_review_thread_resolution: true`). An answered or
   even outdated reviewer thread still blocks the merge. Check with GraphQL
   `pullRequest(number){ reviewThreads(first:50){ nodes{ id isResolved isOutdated path } } }` and,
   once the thread is genuinely addressed (fix landed and answered), resolve it with
   `resolveReviewThread(input:{threadId})`. This is what stalled #9986 for an hour on 2026-08-25
   despite a valid approval.
2. **Strict up-to-date status checks** (`strict_required_status_checks_policy: true`): the head's
   parent must be the current `staging` tip. On a busy day staging moves every few minutes; rebase
   (`gh pr update-branch --rebase` keeps the single commit) and re-verify the stable patch-id.
3. **Approvals are dismissed on push** (`dismiss_stale_reviews_on_push: true`): any rebase or amend
   after the approval requires a fresh approval. Sequence pushes so the approver acts on the final
   head; do not rebase an approved PR "just because" staging moved unless the ruleset forces it.
4. **Extra approval for unattributed changes** (`require_extra_approval_for_unattributed_changes`):
   commits whose author email is not linked to a GitHub account need a second approval. Check
   `gh api repos/<o>/<r>/commits/<sha> --jq '.author.login'` (null = unattributed).
5. Required contexts (`test (1..4)`, `risk-tier-policy / risk-tier-policy`, `typecheck`) — read them
   from the ruleset, not from memory; `skipping` on a non-required job is fine.

`reviewDecision` is often empty under rulesets; do not read it as "no approval". Read the reviews
list (`state == APPROVED` on the exact head) and the ruleset predicates above instead.

## Approval routes per risk tier (2026-09-04, from the #1718 three-hour idle)

- **Yellow:** the gate is the claude workflow. The moment the PR is READY (`gh pr ready`), post `gh pr comment <n> --body /claude-review`; the resulting `claude[bot]` review is the approval the ruleset accepts (#1710 merged on it). The workflow skips drafts, so ready first. Verify a review object appeared; a run can report success with no comment — retry once on the same head, then stop. Diffs above ~5k changed lines in a single commit produce no review body (C-20484) → owner fallback (recorded human closure + human approval).
- **Red:** a human approver is required in addition; the author cannot approve their own PR. **Mark the PR READY (`gh pr ready`) before the approval is requested — never ask a human to approve a draft** (owner rule 2026-09-09; a draft cannot be approved into a merge and idles the approver).
- **`system-courier` approvals are not a route.** They appeared on B/C/D and #1716 after the owner acted; the manager cannot trigger or rely on them. Waiting for one idled a DEV-proven, CI-green PR for three hours.
- Arming `gh pr merge --auto --merge` before the approval is fine (it fires on approval + green); a content-identical rebase kept the approval on this repo (observed on #1716), but verify `reviewDecision` after every force-push.

## Approval sequencing under strict up-to-date

`staging` is strict up-to-date and dismisses approvals on push: any merge knocks other READY PRs BEHIND and their rebase voids the approval.

- Rebase, then ask for the approval, one PR at a time; post the exact head.
- Never rebase an approved PR unless `mergeStateStatus` is `BEHIND` (`UNKNOWN` = recomputing).
- Rebases, merges and approvals run from a utility lane; the manager pane is classifier-blocked for `gh pr merge` / `gh pr review`.
- Stacked PRs refuse `--auto`; after approval + green use `gh pr merge <n> --merge`, then rebase the upper layer.
- Approve with the host `gh` identity only on the owner's explicit word for that PR, quoted in the review body.

## Lessons 2026-09-04 — a PR that edits workflow files gets no PR-event CI

**Root cause before you reach for the close/reopen remedy above.** If the PR's diff (against ITS base) touches `.github/workflows/**`, the repository's `pull_request` workflows do not run at all: zero check-runs on the head, `gh pr checks` reports none, and `statusCheckRollup` is empty. This is an org/token `workflows` permission policy, not a stuck event. Verified A/B on 2026-09-03/04: #10160 (diff contained two workflow-file lines) produced nothing across three heads, while its stacked child #10161 — same repo, same actor, minutes apart, same commits in the branch but no workflow edits **in its own diff vs its base** — triggered normally on every push. Compare "does the PR's DIFF touch `.github/**`", not "does the branch contain those commits".

Consequences:

- **`close`/`reopen` does not fix it.** `on: pull_request` with no `types:` defaults to `[opened, synchronize, reopened]`, so the event fires and is simply not honoured. (The close/reopen recipe above remains correct for a genuinely dropped event.)
- **`gh workflow run backend-pr.yml --ref <branch>` is a SIGNAL, not a GATE.** It succeeds and creates check-runs on the commit, but they never enter the PR's rollup, so required checks stay unsatisfied. Never report a dispatched run as "CI passing" on the PR.
- **Durable fix: move the workflow-file edits into their own PR** (they are usually env values that belong with the release anyway). The moment the feature PR's diff stops touching `.github/**`, PR CI re-registers on the next push.
- A PR in this state also shows `mergeStateStatus: DIRTY`/`BLOCKED` with only external checks (e.g. `codecov/*`) in the rollup — do not read that as the repository's verdict.

## Lessons 2026-09-06 — reading the Claude gate and the non-required checks

- **The sticky review is authored by `github-actions[bot]`, not a "claude" login.** Find it by its
  marker `<!-- backend-claude-review -->` and read `<!-- reviewed-tree: <sha> -->` from the same
  comment. A monitor that greps the comment author for "claude" sees nothing and reports the gate as
  pending; one cost 55 minutes of false waiting. The comment is edited in place across re-runs, so
  compare `reviewed-tree` with `git rev-parse <head>^{tree}` before trusting a verdict — an unchanged
  body may still describe the previous head.
- **"💬 Issues to address" is not automatically a blocking verdict.** Read the findings: each carries
  its own severity, and a comment whose findings are all marked *advisory* has no blocking item.
  Disposition each advisory explicitly — in the PR and in the ledger — rather than either treating the
  headline as a block or letting an advisory pass unanswered. "✅ No blocking issues" may still carry
  advisories that need the same disposition.
- **Know which failing checks are actually required.** On Backend `staging` the ruleset requires
  `test (1..4)`, `typecheck`, `lint` and `risk-tier-policy`; `codecov/patch` and `codecov/project` are
  **not** required and a red codecov does not block merge. Say so plainly rather than reporting "CI is
  failing" — and if the owner elects to treat codecov as their gate, treat lifting it as their
  decision and fix coverage with real tests, never by adding the file to a coverage-ignore list.

## Lessons 2026-09-09 — stacked PRs and the sequential approval chain
- A PR that is the base of a GitHub stack refuses `gh pr merge --auto` AND `gh pr merge --merge` ("must be merged using the asynchronous merge REST API"). The only path: `gh api -X PUT repos/<o>/<r>/pulls/<n>/merge-async -f merge_method=merge -f merge_action=default -f sha=<head>` → 202 `{status, details.uuid}` → poll `GET …/merge-async/<uuid>` until `merged`/`failed`. Merging position 1 merges only that PR; GitHub then auto-rebases the dependent PR onto the base — its head CHANGES, so any lane holding that branch must fetch and prove content identity before pushing (never force over the new head).
- Several READY red PRs on one base: approvals are dismissed on push and strict up-to-date applies ⇒ rebase the remaining PRs after EACH merge, then request the next approval, one PR at a time. `system-courier` re-approves each new head within minutes; a human approval must be asked for only after the rebase.
- A `gh pr view … --json` from the workspace root fails ("no git remotes"); run `gh` from a repo checkout.

## Lessons 2026-09-10 — release PR refresh vs stale review
- `automatic-release-pr.yml` (`mode: create`, `workflow_dispatch`) **refreshes the open release PR in place** (new head from staging, same title/number) — it does not open a fresh PR. A `CHANGES_REQUESTED` review survives the refresh and still gates the merge; clearing it is a maintainer "Dismiss review" or the reviewer's re-review. Never promise "cut a new release PR" as a way around a stale review.
