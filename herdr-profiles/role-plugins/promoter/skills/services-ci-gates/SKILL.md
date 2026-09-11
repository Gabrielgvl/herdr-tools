---
name: services-ci-gates
description: What actually gates a trycourier/services PR — reviewdog, architecture checks, pnpm, Claude review, and merge governance. Load before opening, readying, babysitting, debugging, or merging any services PR.
---

# services CI gates & merge governance

trycourier/services has gates that a passing `nx affected:lint`/`:test` does NOT cover. Load this skill before **readying, babysitting, or merging** any trycourier/services PR, as well as before pushing or debugging one. Generic PR babysitting or merge-method defaults never override this repository-specific governance.

## eslint-reviewdog (the strict lint gate)

- Job runs `bash tools/eslint-rules/reviewdog-lint.sh`: `eslint --rulesdir tools/eslint-rules` over files changed vs `origin/staging`, piped to `reviewdog -fail-level=warning -filter-mode=added`.
- **Any eslint WARNING (not just error) on an ADDED line fails the check** — even though `nx affected:lint` exits 0 on warnings. Green nx lint ≠ green PR.
- **A red `eslint-reviewdog` next to a green `nx lint` is the EXPECTED steady state for a real warning on an added line — NOT evidence of a reporter bug or false positive.** Do not narrate it as a "known quirk" or wave it off; run the reproduction below and fix the finding. (Confirmed on #1362: the red check was a genuine `no-unnecessary-type-assertion` warning, not a quirk.)
- Reproduce locally: recompute the changed set (`git diff --name-only --diff-filter=ACMR origin/staging...HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx'`) and run `eslint --rulesdir tools/eslint-rules --max-warnings=0 -- <files>`. If a **type-aware** rule (e.g. `no-unnecessary-type-assertion`) does NOT reproduce that way — `parserOptions.projectService` may not assign an arbitrary single file to a TS program, so a bare `eslint <file>` silently finds nothing — reproduce with `nx lint <project>` or the real `BASE_REF=staging bash tools/eslint-rules/reviewdog-lint.sh`, which load the full program.
- **NEVER resolve a reviewdog finding with `eslint-disable` (inline or file-level) or by downgrading/removing the rule — always FIX the underlying warning** (fix the types, remove the unused var, reorder imports, split the file, etc.). A *scoped* disable with a justification comment is still a disable and is NOT acceptable, even when the finding looks like a cross-lib type-degradation false-flag: find a real code fix that satisfies both `tsc` (the `build` gate) and the type-aware rule. If you believe a finding is genuinely unfixable without a disable, stop and escalate to the human — do not merge a disable.
- `filter-mode=added` = only findings on lines your PR adds/changes count; pre-existing warnings on unchanged lines are ignored (a modified file can still pass).

## enforce-module-boundaries only surfaces in CI

- `@nrwl/nx/enforce-module-boundaries` is graph/type-aware. It often does NOT reproduce in a local vanilla `eslint` run or against a stale nx daemon, but DOES fire in CI (fresh graph). If reviewdog flags a boundary violation you can't reproduce, `nx reset` and/or fresh `pnpm install`, or trust CI.
- `architecture-validation.test.ts` hard-gates `.eslintrc.json`: **AC5** — production kinds must NOT depend on `kind:test-support`; **AC7** — the rule's `allow` list must stay `[]` (no global bypass) and no `exception:` tags. So you CANNOT fix a boundary violation by adding to `allow` or loosening a production depConstraint — check these ACs BEFORE editing `.eslintrc.json`.
- Test files importing `kind:test-support` (e.g. `@trycourier/test-containers`) are a repo-wide tolerated `"warn"` — permit them with a **test-file-scoped** `overrides` entry (`files: ["*.test.ts", ...]`) that restates the depConstraints plus `kind:test-support`, never the global `allow`.

## pnpm frozen-lockfile

- services is pnpm (`packageManager: pnpm@11.9.0`; `pnpm-lock.yaml` + `pnpm-workspace.yaml`, no `package-lock.json`). CI runs `pnpm install --frozen-lockfile`.
- Any `package.json` dependency change REQUIRES updating the lockfile: `pnpm install --lockfile-only`, commit `pnpm-lock.yaml`. Otherwise CI fails `ERR_PNPM_OUTDATED_LOCKFILE`, which takes build/lint/test/reviewdog DOWN TOGETHER (shared install step). A mass, fast (~30s) failure of all those jobs usually means the lockfile, not a real regression.

## Focused local Jest runs (send-pipeline)

For focused send-pipeline specs, bypass Nx and invoke Jest with the app config directly:

```bash
pnpm exec jest --config apps/send-pipeline/jest.config.js --runInBand \
  apps/send-pipeline/src/path/to/first.spec.ts \
  apps/send-pipeline/src/path/to/second.spec.ts \
  --coverage=false
```

Direct Jest accepts multiple spec paths. Nx forwarding with `--testPathPatterns` can unexpectedly select broad suites, while passing multiple paths through Nx `--runTestsByPath` can result in only the final path being selected. If a broad run is necessary, capture/summarize its output with context-mode instead of flooding the working context with raw Jest logs.

## Deterministic failure triage

Triage evidence for the **current PR `headSha` first**. Before changing code, record the current GitHub PR head and ensure every check, log, annotation, and diff belongs to that exact SHA. Results from an earlier head are historical evidence, not a current failure.

Classify each current-head failure before editing:

1. **Code failure** — the PR change causes a reproducible lint, build, test, architecture, or contract failure. Fix the smallest causal code/test/config scope.
2. **Reporter failure** — the underlying command passed or produced valid output, but reviewdog, annotations, artifact upload, or result parsing failed. Fix reporter configuration only when evidence proves the reporter is causal; a red reviewdog check with a real warning is a code failure, as described above.
3. **Infrastructure/transient failure** — GitHub/API 5xx, runner loss, network/package-registry outage, cancelled job, or diff-unavailable response. Rerun GitHub 5xx and diff-unavailable failures before editing. Do not change repository code to compensate for an unconfirmed transient.
4. **Known baseline failure** — reproduce or cite the documented unrelated failure on the base/current default branch and show that the PR did not cause it. Never label a failure "baseline" from memory alone.

Repository-wide CI, workflow, lint-rule, Nx, or architecture-policy edits require explicit acceptance criteria or explicit user approval. Do not make them as opportunistic fixes for a ticket-scoped failure.

When the documented unrelated baseline prevents the full local target from going green, run focused tests for every changed behavior and require the **current-head CI** result. Record the exact baseline evidence and the focused commands; do not claim the unavailable full target passed.

A check reported as skipped after a rebase is valid evidence only when an authoritative source proves equivalent patch/tree identity between the tested SHA and current head (for example, identical Git tree IDs or an authoritative patch-id comparison covering the check's scope). Same commit message, file list, or intended diff is insufficient.

The Nx deep-import/build-order exception below remains valid: classify it from the missing project-graph edge and clean-shard behavior, then apply the documented `implicitDependencies` tactical fix rather than treating every missing `dist` error as generic infrastructure.

## PR publication authorization

Routine, prescribed delivery-gate writes are manager authority and need no per-action user permission:
post the exact `/claude-review` trigger when this skill requires it and mark a clean PR READY. After every
required exact-current-head gate passes, immediately mark the PR READY if needed and invoke the
repository-approved auto-merge command without another owner prompt. This standing approval never
authorizes a direct/admin bypass. Reverify the exact head and duplicate/history gate immediately before
each write. Ask the owner only when the action changes scope or material cost, touches
production/irreversible/high-blast-radius behavior, makes a security-policy trade-off, or bypasses
normal governance.

This standing authority does **not** authorize discretionary prose. Use a bodyless approval unless the
user separately requests body text, and do not publish validation summaries by default.

An explicitly authorized validation-plan comment uses exactly `<!-- aicodeflow-validation-plan:v1 ticket=<ticket-id> head=<40-char-sha> digest=<64-char-sha256> -->`, where the digest covers the formatted plan. Serialize publication with an atomic repo-git-common-dir lock, verify the current PR head, fetch and parse every existing issue-comment page before each write, and skip a matching marker. A lock, head, history-fetch, or parse error fails closed: publish nothing and report the gate blocked.

## Merge governance (tiered-review ruleset)

Before any merge attempt, execute this repository-governance preflight in order:

1. Query the live allowed methods first:
   ```bash
   gh repo view trycourier/services --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed
   ```
2. Require `mergeCommitAllowed=true`, `squashMergeAllowed=false`, and `rebaseMergeAllowed=false`. Stop and escalate if the live settings differ; do not guess or fall back to a generic merge preference.
3. Do **not** queue auto-merge yet. First complete the tier-specific review, harvest and resolve its findings, and re-check current-head CI and mergeability as described below. If resolving a finding or rebasing changes the head, repeat the tier-specific review for the new head before queueing. Queuing early can let the approval merge a PR before its findings are inspected.

Never attempt `gh pr merge --squash` or `gh pr merge --rebase` for services; this prohibition is about merge methods, not branch updates. `gh pr update-branch <n> --rebase` and manual branch rebases remain allowed—and are required when appropriate—to preserve the single-commit PR branch. Never omit `--auto` from the eventual `gh pr merge --merge` command. Never use `--admin` without explicit authorization for that specific governance bypass.

- `staging` is protected by a ruleset ("Merge governance — tiered review by path") requiring an approving review for certain paths. A conflict-free PR with every check green still shows `mergeStateStatus: BLOCKED` until approved.
- A direct `gh pr merge <n> --merge` reports "base branch policy prohibits the merge." `--merge --auto` queues it and merges automatically once the approval lands.
- Merge commits are allowed; squash and rebase merges are disallowed. `enforce-single-commit` keeps the PR branch to one commit while the repository records the merge commit.
- **BEHIND branch ⇒ rebase (never a merge-in).** A `mergeStateStatus: BEHIND` PR must be up to date before it can merge (`gh pr merge` fails "N of N required status checks are expected"). Do NOT do a *merge-in* — bare `gh pr update-branch` (default) or `git merge origin/staging` adds a merge commit and trips `enforce-single-commit`. Two clean options that preserve the single commit: (1) **`gh pr update-branch <n> --rebase`** — server-side rebase, no local worktree needed; verified on PR #1373 (C-19186) to keep it one commit, `enforce-single-commit` stayed green, PR merged. Requires a `gh` new enough to have the `--rebase` flag — if absent, fall back to (2). (2) **manual rebase + force-push** — `git rebase origin/staging` in a worktree, `git push --force-with-lease`. Merging several stacked PRs is strictly sequential either way: each merge moves `staging`, making the next BEHIND again → rebase it, wait for CI, merge. After any rebase/force-push, re-confirm `mergeStateStatus: CLEAN` (and mind the `--watch` latch note below) before merging.
- **`review / review` (Codex) is NOT a required check** — it shows as `UNSTABLE`, not `BLOCKED`, and does not block `--merge`. A fast (~11s) `review/review` failure is usually the gate job erroring, not a real P0/P1 finding; don't chase it to merge.
- After a **force-push**, `gh pr checks --watch` can latch onto the PRE-push run and exit green while the new run is still pending → a premature merge attempt then hits `BLOCKED`. Sleep ~30s (let the new run register) before `--watch`, and re-confirm `mergeStateStatus: CLEAN` right before merging.
- When **scripting** over `gh pr checks <n>` output, parse it **tab-delimited** (`awk -F'\t'`): the columns are `<name>\t<state>\t<elapsed>\t<url>` and check names contain spaces (`lint (24.x)`), so a whitespace split reads `(24.x)` as the state and mis-detects "resolved." (Cost a wasted watch cycle in C-19382.)

### Risk tiers → the approving review each needs

The `risk-tier-policy / risk-tier-policy` check classifies a PR by its changed paths into a risk tier (surfaced as a `risk:green|yellow|red` label). The tiered-review ruleset routes the *required approving review* by that tier — so the mechanism that satisfies the review requirement differs per tier, and it is NOT always a human:

- **`risk:yellow`** — the required approval is granted by the **Claude review bot**, triggered by posting a PR comment whose body is exactly `/claude-review`:
  ```bash
  gh pr comment <n> --body "/claude-review"
  ```
  The bot reviews the diff and posts the approving review; **no human review is required for yellow**. This is the normal way to get a yellow PR approved (confirmed on #1408, C-19103). Its verdict can still carry findings — harvest the comment surfaces below and address them; approval ≠ clean.
- **`risk:green`** — like yellow, **requires no human approval; a current-head Claude approval is sufficient**. Lowest-risk/docs-only paths normally receive the sanctioned bot approval through `auto-approve-docs`, so no manual action is usually needed. If that approval is absent, use `/claude-review`; do not escalate to a human solely to satisfy the green approval gate.
- **`risk:red`** (and other higher-risk routes) — require a **human** approving review; the `/claude-review` bot approval does **not** satisfy these. (This is the tier the "bot `APPROVED` with `authorAssociation: NONE` does not satisfy the rule" caveat below is about — that caveat is tier-specific, not a blanket statement that bot approval never counts.)

**Hard rule:** never request or wait for a human reviewer solely because a `risk:green` or `risk:yellow` PR lacks approval. Verify the current immutable head, then use the sanctioned bot route (`auto-approve-docs` for green when present, otherwise `/claude-review`). Human approval is an additional optional review on these tiers, not a merge gate.

### Robust Claude-review waiter

Before posting an explicitly authorized `/claude-review` request, bind the request to the current PR head and capture all existing Claude result IDs. Then poll all three paginated result surfaces: issue comments, review bodies/verdicts, and inline review comments. Retain every baseline ID, including markerless issue comments whose `commit_id` is null. Accept results only when they were absent from that baseline and explicitly name the requested head; complete the waiter only after a new head-bound review reaches a terminal state. A successful command with an empty jq result is still **not** a review. The terminal success condition must explicitly be `length > 0`, and the waiter must time out instead of hanging forever:

```bash
owner=trycourier
repo=services
pr=<n>

# The authoritative sticky review is posted by `github-actions[bot]`, whose login
# does not contain "claude", and it is edited in place, so its comment id never
# changes. Selecting on login alone never collects it, and keying freshness on id
# alone can never see an in-place edit. Every surface therefore also selects the
# `<!-- backend-claude-review -->` marker, and every key carries the comment's own
# `updated_at`, so an edited-in-place sticky result registers as a new result.
collect_claude_results() {
  local issue_results review_results inline_results
  issue_results="$(gh api "repos/$owner/$repo/issues/$pr/comments" --paginate --jq '
    .[] | select(
      (((.user.login // "") | ascii_downcase | contains("claude")) or
       ((.body // "") | contains("<!-- backend-claude-review -->"))) and
      ((.body // "") | length > 0)
    ) | {
      key: ("issue:" + (.id | tostring) + "@" + ((.updated_at // .created_at) // "")),
      surface: "issue",
      id,
      body,
      updated_at: ((.updated_at // .created_at) // ""),
      sticky: ((.body // "") | contains("<!-- backend-claude-review -->")),
      commit_id: (try ((.body // "") | capture("<!-- reviewed-tree: (?<sha>[0-9a-f]{40}) -->").sha) catch null)
    }
  ')" || return 1
  review_results="$(gh api "repos/$owner/$repo/pulls/$pr/reviews" --paginate --jq '
    .[] | select(
      (((.user.login // "") | ascii_downcase | contains("claude")) or
       ((.body // "") | contains("<!-- backend-claude-review -->"))) and
      (((.body // "") | length > 0) or ((.state // "") | length > 0))
    ) | {
      key: ("review:" + (.id | tostring) + "@" + ((.submitted_at // "") // "")),
      surface: "review",
      id,
      body,
      state,
      updated_at: ((.submitted_at // "") // ""),
      sticky: ((.body // "") | contains("<!-- backend-claude-review -->")),
      commit_id
    }
  ')" || return 1
  inline_results="$(gh api "repos/$owner/$repo/pulls/$pr/comments" --paginate --jq '
    .[] | select(
      (((.user.login // "") | ascii_downcase | contains("claude")) or
       ((.body // "") | contains("<!-- backend-claude-review -->"))) and
      ((.body // "") | length > 0)
    ) | {
      key: ("inline:" + (.id | tostring) + "@" + ((.updated_at // .created_at) // "")),
      surface: "inline",
      id,
      body,
      updated_at: ((.updated_at // .created_at) // ""),
      sticky: ((.body // "") | contains("<!-- backend-claude-review -->")),
      commit_id
    }
  ')" || return 1
  printf '%s\n%s\n%s\n' "$issue_results" "$review_results" "$inline_results" | jq -s '.'
}

requested_head="$(gh pr view "$pr" --repo "$owner/$repo" --json headRefOid --jq '.headRefOid')" || exit 1
baseline_results="$(collect_claude_results)" || exit 1
baseline_ids="$(jq '[.[].key]' <<<"$baseline_results")" || exit 1
pre_request_head="$(gh pr view "$pr" --repo "$owner/$repo" --json headRefOid --jq '.headRefOid')" || exit 1
if [ "$pre_request_head" != "$requested_head" ]; then
  echo "PR head changed while collecting the Claude review baseline; do not post a request for the stale head" >&2
  exit 1
fi

# This prescribed delivery-gate write is allowed when this skill requires it; no per-action prompt is needed.
gh pr comment "$pr" --repo "$owner/$repo" --body "/claude-review" || exit 1

review_results='[]'
for attempt in $(seq 1 40); do
  current_head="$(gh pr view "$pr" --repo "$owner/$repo" --json headRefOid --jq '.headRefOid')" || exit 1
  if [ "$current_head" != "$requested_head" ]; then
    echo "PR head changed while waiting for Claude review; request a new review for the current head" >&2
    exit 1
  fi
  all_results="$(collect_claude_results)" || exit 1
  observed_head="$(gh pr view "$pr" --repo "$owner/$repo" --json headRefOid --jq '.headRefOid')" || exit 1
  if [ "$observed_head" != "$requested_head" ]; then
    echo "PR head changed while collecting Claude review results; request a new review for the current head" >&2
    exit 1
  fi
  new_results="$(jq --argjson baseline "$baseline_ids" '
    [.[] | select(.key as $key | ($baseline | index($key)) == null)]
  ' <<<"$all_results")" || exit 1
  head_bound_results="$(jq --arg requested_head "$requested_head" '
    [.[] | select(.commit_id == $requested_head)]
  ' <<<"$new_results")" || exit 1
  terminal_results="$(jq '
    [.[] | select(
      .surface == "review" and
      (((.state // "") | ascii_upcase) as $state |
        (["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"] | index($state)) != null)
    )]
  ' <<<"$head_bound_results")" || exit 1
  sticky_results="$(jq '[.[] | select(.surface == "issue" and .sticky == true)]' <<<"$head_bound_results")" || exit 1
  if jq -e 'length > 0' <<<"$terminal_results" >/dev/null &&
     jq -e 'length > 0' <<<"$sticky_results" >/dev/null; then
    review_results="$terminal_results"
    break
  fi
  sleep 30
done

if ! jq -e 'length > 0' <<<"$review_results" >/dev/null; then
  echo "timed out waiting for a terminal Claude review on head $requested_head" >&2
  exit 1
fi
```

Do not use `jq -e '.[]'`, a bare jq query, or command exit status as the completion test: jq exits 0 for empty output in common query forms. A fresh issue comment is head-bound only when its `<!-- reviewed-tree: <sha> -->` marker equals the requested head, but issue and inline comments never complete the waiter by themselves. Review and inline results must likewise carry the requested head explicitly. Baseline freshness alone is insufficient because a delayed result from an earlier request can arrive after the new baseline. Only both a new marker-bearing sticky issue comment bound to the requested head and a new head-bound review with terminal state `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, or `DISMISSED` release the waiter. The issue comment does not complete the waiter by itself; harvest every new head-bound surface again before proceeding.

After the waiter returns, preserve this ordering:

1. Harvest all three paginated surfaces again and inspect every new result, including the marker-bearing sticky comment. Presence is not the same as approval or cleanliness.
2. **Resolve every finding** before proceeding. If a fix changes the head, the prior review is stale: return to the baseline/request/wait cycle for the new head, subject to the same explicit authorization rule for the `/claude-review` comment.
3. **Re-check current-head CI and mergeability** after the review findings are resolved. Confirm the reviewed head still equals the PR head, all required checks belong to and pass on that head, and `mergeable`/`mergeStateStatus` permit queueing. If the head changes during these checks, restart review validation for the new head.
4. Only then queue auto-merge with the sole allowed method:
   ```bash
   gh pr merge <n> --merge --auto
   ```

Do not queue auto-merge before these review and current-head checks: for `risk:yellow`, the bot approval can satisfy the branch rule immediately, and an already queued PR could merge before its findings are harvested.

## Removing/renaming a CI job that is a required check deadlocks ALL merges

The tiered-review ruleset pins **required status checks by context name**. A check context is `<job-id> (<matrix-value>)` (e.g. `lint (24.x)`). If you delete or rename a job whose context is in the ruleset's `required_status_checks`, that context never posts again — GitHub then holds **every** PR into the default branch perpetually pending on a check that can't complete (`mergeStateStatus: BLOCKED` even when `mergeable: MERGEABLE`). This is repo-wide, not just your PR. (C-19382: folding `eslint-reviewdog` into `lint` stranded the required `eslint-reviewdog (24.x)` context.)

- **Check BEFORE removing/renaming any CI job:** `gh api repos/trycourier/services/rulesets/<id>` → read `rules[].parameters.required_status_checks[].context`. The active ruleset is **15114709** ("Merge governance — tiered review by path").
- **Edit the ruleset in lockstep with the merge** (needs `administration:write`; snapshot first for rollback):
  ```bash
  gh api repos/trycourier/services/rulesets/15114709 > ruleset.backup.json          # rollback snapshot
  # build a PATCH body from that JSON minus the dead context (keep name/target/enforcement/
  # conditions/bypass_actors/rules; drop only the one required_status_checks entry), then:
  gh api --method PUT repos/trycourier/services/rulesets/15114709 --input ruleset-patch.json
  ```
  Keep every still-produced context (e.g. `build (24.x)`, `lint (24.x)`, `test (24.x)`, `risk-tier-policy / risk-tier-policy`); remove only the dead one. A renamed reviewdog check posts under the reporter's `-name`, not the job id — verify the new context and whether the ruleset should require it.
- **Do NOT defer it to a follow-up** — the deadlock lands the moment the job-removing PR merges (including that PR itself). Treat the ruleset edit as an acceptance criterion of the same change.

## Review findings ≠ check status

A green review lane does NOT mean there is nothing to address — reviewers (human and bot) post findings as **comments** that a passing check hides. Before calling a PR clear or merging, harvest ALL THREE comment surfaces:

- **Issue comments:** `gh pr view <n> --json comments` — bot review summaries (e.g. `<!-- backend-claude-review -->`) land here.
- **Review bodies + verdicts:** `gh pr view <n> --json reviews,latestReviews`.
- **Inline review-thread comments:** `gh api repos/{owner}/{repo}/pulls/<n>/comments` — human line-level comments live ONLY here; `--json comments` returns them as *nothing*, so a first pass that only checks issue comments misses them entirely. (On #1362 a real poison-record batch bug arrived this way while every check was green.)

A **findings-summary** bot's `APPROVED` review (e.g. the `<!-- backend-claude-review -->` summary, `authorAssociation: NONE`) does NOT satisfy the required-review rule for a tier that needs one, and can still carry real findings — read the findings; never equate "check green" or a summary-bot "approved" with "clean." (This is distinct from the risk-tier `/claude-review` approval described above under *Risk tiers*, which IS the sanctioned approver for `risk:yellow`.) To reply in-thread to an inline comment: `gh api repos/{o}/{r}/pulls/<n>/comments/<comment_id>/replies -f body=...`.

## pi-review: review the GitHub PR, never a stale local base

`pi-review diff --base <ref>` diffs against the **local** ref. If local `staging` lags `origin/staging` (checkouts drift; observed ~155 commits behind), that diff sweeps in hundreds of already-merged files and the reviewer emits phantom "critical" findings on files the PR never touched (C-19296/PR #1376 cited `apps/llm-executor`; C-19186/PR #1373 cited send-pipeline/terraform). A hard review gate then BLOCKs a clean PR.

- **Always use `pi-review pr <number|url>`** (GitHub-PR mode) — it pulls the authoritative diff from GitHub (same source as `gh pr diff`), so there is no local base to go stale. The `linear-execute` cross-model lens uses `pr` mode for this reason (C-19319).
- If you must run local-diff mode, `git fetch origin <default-branch>` first and pass a fresh ref.
- **The scope oracle is `gh pr diff <n> --name-only`** — never `git diff origin/staging..HEAD` locally (a stale local `origin/staging` ref inflates it with already-merged files). Use it to verify PR scope after a force-push, and as a *tell* when triaging findings.
- **Triage findings by causality, not by whether the cited file is in the diff.** A finding citing zero in-diff files is a *signal* of stale-base contamination, not proof of it: a PR can break a contract whose strongest evidence is an **unchanged** caller (e.g. an API/type signature change that breaks a consumer outside the diff). Before dismissing, ask "is this defect *caused by this PR's change*?" — if yes, it is in-scope and must be fixed even though the cited file is unchanged. Only dismiss (document in the PR body, don't fix) when there is no causal link to the change — the true stale-base case, where the finding is about pre-existing/already-merged code the PR never touches.

## Stacked PRs on an unmerged base (drift → conflicts)

A PR based on **another open, unmerged branch** (common in a migration epic like C-19086 with ~15 stacked children) drifts whenever that base branch is amended/force-pushed during its own review — not just when `staging` moves. Symptoms and the fix (retro session-2026-07-13-C-19274; see memory `[[forcepush-worktree-stale-lease]]`):

- **`mergeable: CONFLICTING` / `mergeStateStatus: DIRTY` with `add/add` conflicts on files you didn't newly add.** Root cause: the base branch was force-rewritten (its old commit is now orphaned), and your child branch still carries that orphaned copy of the base's files. `git merge-tree` shows conflicts, but a `--onto` rebase usually resolves them cleanly (merge-tree does a full 3-way merge incl. the orphan; the rebase replays only your commit's diff).
- **Fix — replay only your commit onto the base's *current* tip:** `git rebase --onto <current-base-tip> <old-base-tip>` (find `<old-base-tip>` as the base commit your branch sits on). Keep a backup ref first (`git branch backup/... HEAD`), then `git push --force-with-lease`.
- **The base is a moving target.** It can be force-pushed again minutes later (this session saw it rewritten twice, even absorbing an unrelated commit). Re-check `gh pr view --json mergeable,mergeStateStatus,baseRefName` after each push; expect to rebase more than once until the base stabilizes.
- **When the base PR merges, GitHub auto-retargets your PR's base to `staging`** and it goes `BEHIND` (not conflicting). That is the moment for the durable fix: `git rebase --onto origin/staging <old-base-tip>` — since the base's content is now in `staging`, this drops the now-merged commits and leaves only your commit. After this you're on a stable base and the churn stops.
- Prefer doing all of this in a **dedicated worktree** to keep the primary checkout clean, and verify the rebased diff is *only* your ticket's files (`git diff --stat origin/staging HEAD`) before force-pushing.

## deploy-staging concurrency

- Merging to `staging` triggers `deploy-staging`, which has a concurrency group (`staging-deploy-<ref>`) that **cancels superseded in-progress runs**. Merging PRs back-to-back cancels the earlier deploy runs — that is expected, not a failure. The run to watch is the one on the current tip; its `nx affected` base is the last SUCCESSFUL staging deploy, so a cancelled run's apps are still picked up by the next successful run. Confirm each app deployed by reading the `deploy-arm64`/`deploy-us` job of the successful run(s), not by run count.

## nx build-order flakes in the sharded `test` job

A sharded `test (N, 24.x)` job can fail with `Cannot find module '@trycourier/<pkg>/src/<subpath>'` (seen: `recipients` → `@trycourier/workspaces/src/hipaa`). It flakes across runs and passes locally.

- **Cause:** the consumer imports a **deep `exports` subpath** that resolves to the dependency's built `dist/`, but nx does NOT infer that deep-subpath import as a project dependency — so `test`'s `dependsOn: ["^build"]` never builds the dependency, and a clean CI shard has no `dist`. Locally it passes only because a prior build left `dist` present. Confirm with `nx graph`: the consumer→dependency edge is missing.
- **`gh run rerun --failed` makes it WORSE** — it re-runs the failed job without rebuilding dependencies, so a build-order flake fails deterministically on rerun. To retry, trigger a **fresh full run** (new push/commit), not a failed-job rerun.
- **Tactical fix:** add the missing edge — `"implicitDependencies": ["<dep-project>"]` in the consumer's `project.json` — so `^build` builds the dep first. Verify with `nx graph`. **The edge won't appear until you `npx nx reset`** (the daemon caches the project graph; editing `project.json`/`implicitDependencies` alone doesn't refresh it). Prove the fix by removing the dep's `dist/` and running `nx test <consumer>` — it must run `nx run <dep>:build` first, then pass.
- **Strategic fix:** the deep `@trycourier/*/src/*` cross-package import is the real anti-pattern (couples to file layout AND breaks the graph). Migrate to a public entrypoint + enforce with a boundary rule; drop the `implicitDependencies` band-aid after. (C-19094 hit this; tracked in C-19293 decouple + C-19292 band-aid.)

## Local false-greens to distrust

- Type-aware eslint rules (`no-unnecessary-type-assertion`, `enforce-module-boundaries`) resolve workspace types from built `dist` in CI but from a stale local `node_modules`/nx daemon otherwise → a local "clean" run can hide real CI findings. Do a fresh `pnpm install` (+ `nx build <lib>`) before trusting local type-aware lint.

## CDK test hygiene (2026-09-06)

- Test fixtures: `new App({ outdir })` under a per-file temp dir removed in `afterAll`; helpers remove their own `mkdtemp`. Leaks filled `/` to 100 % (~52 MB per synth × ~50 per run) and produced an ENOSPC Jest burst that looked like a mass regression — check `df -h /` before reading a mass failure. Fixed in #1715; eslint rule requested (`briefs/request-eslint-rule-no-raw-cdk-app-20260905.md`).

## More false reds and greens (2026-09-06)

- `rtk proxy env … npx cdk synth` exits 0 without running; run synth and the validator directly and check the `cdk.out` mtime.
- READY or a body edit re-fires `pull_request` workflows and cancels the run in flight; read `statusCheckRollup`, not the run list.
- Claude review on diffs above ~5k lines fails with `Review agent produced no comment body`; fallback = owner `system-courier` approval on the exact head + a review-gate closure note in the PR body (#93).
