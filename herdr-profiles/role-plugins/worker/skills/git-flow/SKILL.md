---
name: git-flow
description: Canonical git protocol for AI Code Flow — pre-flight checks, branch naming, worktree isolation for parallel multi-ticket waves, WIP commit cadence, squash-before-PR procedure, push, and failure recovery. Load this from any agent or command that performs git operations, and whenever deciding whether to fan several sibling tickets out concurrently or run them one at a time.
---

# GitFlow Skill

This skill is the shared git protocol for every agent and command in AI Code Flow. The authoritative details live in `docs/context/git-conventions.md` in each repo — this skill is the summary plus the cross-repo invariants. When this skill and the repo's `git-conventions.md` disagree on a repo-specific detail (e.g. default branch name, CI hook), the repo doc wins for that repo.

## Pre-flight checks (before any implementation)

Load `docs/context/git-conventions.md` and run every check in its **Pre-flight Checks** table. If any check fails, stop the command and use the doc's **Failure Recovery** table. For `/create-pr`, first resolve only the repository/worktree and current branch, then perform the command's existing-PR read before normal preflight. If an open PR exists, stop on that read-only path; if none exists, run every normal preflight check before continuing.

Non-negotiable minimum pre-flight:
- Repo is clean (`git status --porcelain` empty) — or changes are expected and accounted for.
- Default branch is detected dynamically, **never hardcoded**. Use the command from `docs/context/git-conventions.md`.
- The current branch matches Linear's `gitBranchName` for the ticket (warn if not — see `linear-mcp` skill).
- `main` (or whatever the default is) is up-to-date with `origin/<default>`.

## Branch naming

Format: `[ticket-id]/[lowercase-kebab-slug]`. Example: `C-17620/add-user-auth`.

- The ticket id MUST be extractable from the branch name (some tools parse it).
- Prefer Linear's `gitBranchName` suggestion — it already matches this format.
- One branch per Linear ticket. Sub-tickets under a parent each get their own branch.

## Worktrees (parallel execution)

When `/linear-execute-all` or the `manager` agent dispatches independent sub-tickets in parallel:

- Create worktrees at absolute workspace-sibling paths, never inside the source repository. For a repo at `/workspace/services`, use a path such as `/workspace/services-c-12345-short-slug` and pass that absolute path to `git worktree add`; do not use `services/.worktrees/...` or a current-directory-relative destination.
- Each parallel child runs in its own git worktree (`isolation: "worktree"` on the `Agent` tool).
- Worktrees require a clean working tree at dispatch time.
- `node_modules/` is symlinked into the worktree by Claude Code — no re-install needed.
- After the parallel step, the `integrator` agent reconciles diffs across worktrees into one recommendation. The `manager` itself does NOT merge worktree outputs in its own context.

### Fanning out a multi-ticket wave

When a parent fans out into sibling children that each apply a well-understood change to a DIFFERENT file area (one CDK app each in an arm64 wave, say), only the **git operations** collide — branch checkout/commit/push all mutate one working tree. That collision is solved by per-run worktree isolation, not by serializing, so do not default to one ticket at a time. Stay sequential only when there is a real ordering dependency (child B needs A's merge) or the change is still exploratory.

- Run the wave as **one** workflow whose mutating stages are worktree-isolated. Never launch several top-level `/linear-execute` invocations concurrently against the same repo — they share the session working tree and WILL clobber each other's branch checkouts. (A parent's `needs-user` gate resume is all-or-nothing, so executing only a valid subset of children means hand-authoring that combined workflow; see `workflows/dynamic/IMPROVEMENTS.md` A10.)
- Each mutating stage branches explicitly off the freshly fetched default (`git fetch && git checkout -B <linear-branch> origin/<default>`) and pushes. The remote branch and its PR survive the isolated worktree's auto-clean, so the worktree is disposable but the delivery is not.
- Keep shared, cross-cutting bookkeeping — a hand-maintained inventory/plan doc, aggregate counts — OUT of the per-ticket PRs. Do it once in a final serial stage, or N children conflict on the same shared file.
- Review stages read the pushed diff (`gh pr diff <n>`, or `git diff origin/<default>...origin/<branch>`), so they need no worktree of their own.
- Landing the resulting PRs is still sequential wherever the repo enforces up-to-date + single-commit — rebase each in turn (see **Updating a branch that is behind the base** below, and `services-ci-gates`).

### Repository writer ownership

- The per-ticket writer lease has been removed. A dynamic execution run mutates its delivery branch directly; avoiding concurrent runs against the same ticket is the caller's responsibility.
- One top-level run owns tracked mutations. Its implementers/fixers run with `isolation: "worktree"`. Never start detached/background commands from a writer. Distinct parallel partitions require distinct branches.
- A completion notification is not proof that descendants stopped. Before manual recovery, inspect the run state, workflow jobs, worktrees, local/remote branch heads, and PR head. Stop/join only positively identified writers; otherwise use a separate worktree. Preserve partial work; never delete another run's worktree.
- Final CI run IDs belong in ignored workflow state/feedback; do not amend the tracked handoff solely to say CI passed.
- Final readiness requires the reviewed SHA to equal the PR head before and after CI sampling, mergeability sampling, and `gh pr ready`.

## Commit cadence

- During implementation, make **WIP commits** after each meaningful unit of work: `git commit -m "wip: [brief description]"`.
- Never commit a failing build or failing tests, even as WIP.
- WIP commits are squashed before the PR opens — they are a trail for the reviewer and a safety net for your work, not shipped history.

## Squash procedure (before PR)

One commit per Linear ticket is a hard rule (see `CLAUDE.md` rule 10). Before opening the PR:

1. Ensure the handoff from `/handoff` is staged — it must be included in the final commit.
2. Follow the **Squash Procedure** in `docs/context/git-conventions.md`. Derive the commit summary from the working commit log.
3. Final commit message format (from `CLAUDE.md`):

   ```
   [TICKET-ID] Short description of what was done

   - What changed and why (not how — the diff shows how)
   - Any open items that surfaced that are NOT yet Linear tickets
   - ADR IDs referenced or proposed (e.g. "Complies with ADR-001, ADR-003")
   ```

4. Never amend a published commit during ordinary development. If the squashed commit needs changes after push, create a new commit unless the narrow review-fix exception below applies.

### Draft PR review-fix exception

`/linear-execute` may amend a published commit automatically only during its review-fix loop. The repository's one-commit-per-PR rule must require the fix to remain in exactly one squashed commit. The workflow may continue work created by a prior `/linear-execute` invocation only after a read-only authorization check verifies and captures the exact remote SHA, exact Linear branch, authenticated commit/PR author, repository identity, unprotected non-default branch, one-commit default-base-to-head range with the PR base exactly equal to the repository default, and the exact ticket's hidden PR marker or `AI-Code-Flow-Ticket: <ticket>` commit trailer.

**Stacked-layer exception (native GitHub Stacked PRs):** when `/linear-execute` runs with an explicit `stackBase` argument — a mid-stack layer PR produced by its approved stack-split path — the PR base must equal that exact `stackBase` branch (the previous layer's ticket branch) instead of the repository default, and the one-commit range is measured `stackBase..head`. Every other authorization condition is unchanged, `stackBase` must never name a default/shared/release branch, and after any push to a layer branch the writer must run `gh stack sync` and report whether it succeeded. Continuation must amend that one commit and push only with a lease pinned to the captured SHA; any mismatch or lease failure stops. Ordinary pre-existing work remains ineligible. Missing provenance/count fields fail closed. This is not general permission to rewrite published history.

Every newly created implementation PR, including one created after resuming a branch that had no PR, must carry this run's exact hidden marker, pass the same read-only branch/repository/PR-author/head-author/provenance/one-commit authorization, and be confirmed as a draft before review or readiness, even when no review fix is needed; the initial review head must still equal that exact authorized delivery head.

Before using the exception:

1. Confirm the PR is open, same-repository, targets the repository default branch (or, for a stacked layer run with `stackBase`, exactly that stack base branch), is authored by the authenticated user, and its current head commit is also authored by that user; require the exact Linear `gitBranchName` and exactly one base-to-head commit for every new, resumed, fixed, or repaired delivery. For a newly created PR require this run's exact hidden marker; only a safely pre-authorized resume may use an earlier exact-ticket marker or trailer. Point-in-time absence at ticket fetch is not sufficient provenance.
2. Parse `owner/name` from the PR URL and require it to equal `gh repo view --json nameWithOwner` in the current checkout. `isCrossRepository=false` alone does not prove the checkout origin is the PR repository.
3. Query the repository's actual default branch and the ticket branch's protection state through GitHub. Deny default, protected, release, shared (`develop`, `development`, `trunk`, `staging`, `production`), or teammate-owned branches; a branch-name denylist alone is not sufficient.
4. Fetch the remote ticket branch and capture its exact SHA as `<expected-remote-sha>`.
5. Keep tests/build green, update and stage the ticket handoff with the fix, then amend the single commit. Re-read the remote/PR head, require it to differ from the authorized pre-fix SHA, and reauthorize its branch/repository/PR author/head author/provenance/one-commit evidence before rereview. Any resumed-work checkout/lease instruction in the fix prompt must be rebound from the original continuation SHA to this current authorized PR head; a fix prompt must not also carry new-branch/default-base creation instructions. Reauthorize the unchanged head and all branch/base/draft/protection/repository/ownership/provenance/one-commit metadata immediately before marking the PR ready; the mark-ready operation must recheck the expected PR/remote head before and after `gh pr ready` and treat any in-operation advance as non-merge-ready.
6. Push with a pinned lease: `git push --force-with-lease=refs/heads/<branch>:<expected-remote-sha> origin HEAD:<branch>`.
7. If the lease fails, stop: the remote advanced and must be reconciled. Never retry with plain `--force` or an unpinned rewrite.

A ready-for-review PR may still need this exception when review finds a blocker; the rewrite invalidates prior review state, so rerun all required review/CI gates before treating it as ready again.

The same independently rechecked repository identity, exact Linear branch, default-branch/protection status, PR and head-commit ownership, one-commit count, provenance, and exact-head safeguards authorize a user-directed **handoff-repair** amendment when the hard `gate.execute.handoff` fails after review. Amend only the required handoff repair into the single ticket commit, use the pinned lease form above, and resume with the workflow-provided `handoffEvidenceRevision`; set `handoffPathOverride` when correcting a malformed cached path. The revision changes only the read-only evidence prompt, while validated `handoffRepairContext` binds a complete one-to-one fingerprint of every non-handoff PR file to its reviewed Git blob SHA. Only a path that passed the canonical handoff-path check may be excluded. The baseline is immutable across failed repair attempts; if initial evidence cannot establish it, abort and do not instruct a repair. Repair mode skips implementation, parallel integration, and review-fix agents entirely, including in a fresh session, but always reruns review lenses read-only because resume args are caller-controlled and the ticket specification may have changed. This avoids both a forbidden second commit and stale journal evidence; it does not authorize unrelated code changes after the review loop.

## Push

Follow the **Push** section in `docs/context/git-conventions.md`. Default: `git push -u origin <branch>` first time, `git push` thereafter.

- Never `--force` to `main` / default branch.
- A pinned `--force-with-lease` on the authenticated user's verified, unprotected ticket branch is routine manager authority when required to preserve the one-commit rule; it needs no per-push permission ask. Any other branch or unpinned/destructive force push requires explicit user authorization.
- Never skip hooks (`--no-verify`) unless the user explicitly asks. If a hook fails, investigate and fix — do not bypass.

## Final base and diff verification

For PR creation, first perform the read-only existing-PR check from `/create-pr`, capturing its output in `EXISTING_PR_URL` and its exit status in `EXISTING_PR_STATUS`. A nonzero status fails closed: stop on authentication, network, or API errors without running normal preflight or writes. If the status is zero and a URL exists, print it and stop without fetching or rewriting the branch. Continue only after a successful empty result; immediately before final verification, push, or PR creation:

1. Resolve the authoritative default branch from GitHub, then fetch it into the tracking ref consumed below: `DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')` followed by `git fetch origin "$DEFAULT_BRANCH:refs/remotes/origin/$DEFAULT_BRANCH"`.
2. Check `git rev-list --count "HEAD..origin/$DEFAULT_BRANCH"`. If it is nonzero, stop PR preparation and rebase the ticket branch onto `origin/$DEFAULT_BRANCH` using the repository's single-commit-safe procedure.
3. After any rebase, rerun every affected test, build, lint, and generated-file validation. Earlier green results are stale after the base changes.
4. Inspect `git diff --stat "origin/$DEFAULT_BRANCH"..HEAD` and confirm every path and deletion belongs to the ticket. Stop and investigate an unexpectedly broad or deletion-heavy diff; do not push or open the PR until the scope is understood and corrected.

This check must use the freshly fetched remote default, not a stale local default branch.

### Authoritative sources for PR-relative facts (never derive them from local state)

In this multi-worktree monorepo a local branch ref routinely lags `origin` by 50–200+ commits, and a checkout's git identity/config is not the GitHub account. So whenever a fact **re-gates a decision** (a review / merge / handoff / provenance gate), derive it ONLY from the authoritative remote source — never from local `git config`, a local ref, or a shell wrapper's summary:

- **Authenticated identity / PR author / commit author** → `gh api user --jq .login` and `gh pr view <n> --json author,commits` (GitHub logins). NOT `git config user.name` — a local display name (e.g. `gabriel`) is not the GitHub login (e.g. `Gabrielgvl`), and comparing the two false-fails author/provenance checks.
- **Commit count / ahead-behind** → `gh pr view <n> --json commits` (length). NOT `git rev-list <base>..HEAD` against a local base ref, which is inflated by a stale local default branch (observed 218 commits behind → a "1-commit" PR counted as 219).
- **PR / remote head SHA** → `gh pr view <n> --json headRefOid` and `git ls-remote origin refs/heads/<branch>` (literal branch, never an empty ref). NOT `git rev-parse HEAD` of whatever checkout you happen to be in.
- **Repository** → `gh repo view --json nameWithOwner` (`owner/repo`). NOT a full `https://…` URL and not a `.git`-suffixed form.
- **Changed files** → `gh pr diff <n> --name-only`. NOT a local diff against a possibly-stale base.
- **Changed-line count** (the PR LOC budget, a size exception) → `git diff --numstat HEAD^ HEAD` for a single-commit branch, i.e. that commit against its own parent. NOT `origin/<default>..HEAD`, a two-dot **tree** diff that swallows everything landed on the base since the fork as soon as the base moves (observed: 7,067 versus the true 2,449).
- **Clean working tree** → the RAW bytes of `git status --porcelain=v1` (empty output = clean). NEVER a wrapper's summary word (e.g. a bare `ok`), which is not valid porcelain and reads as "unparseable/dirty" to a strict gate.

This is a recurring failure class: local-vs-authoritative drift has false-blocked correct PRs at least three times (the cross-model lens on a stale base, a PR-scope check, and the C-19103 `linear-execute` evidence gates across 5 resumes — git-config login, stale-`staging` commit count, local `rev-parse` head, and an `ok` status word). Prefer computing such facts in a small deterministic helper that shells out to `gh`/`git`, not via an LLM step that can pick the wrong source.

## PR creation

Run `/create-pr` for every PR. It:
- Validates the branch state.
- Uses `gh pr create --draft` with a HEREDOC body so formatting survives (draft-by-default — see below).
- Does NOT add the Claude Code / Anthropic attribution footer in this repo's convention — the squashed commit is what it is, no auto-credits.

If PR creation fails, stop and inform the user. Do not proceed to review gates without a PR number.

### Draft-by-default → ready-when-clean (Claude Code repos: Frontend / Backend / Services)

Team policy (Dan, 2026-07): a PR **iterates in Draft** while it is still being worked on and reviewed locally, and is brought out of draft **only when it is clean locally**.

- **Open every PR as a draft** (`gh pr create --draft`). This holds whether the PR is opened by `/create-pr`, by a human, or by a dynamic workflow.
- Every code or infrastructure revision must be actually deployed to the applicable dev environment and pass representative smoke validation against the exact PR head before any review request, the first `pi-review`, or `gh pr ready`. Use the repository's deployment skill or documented procedure; for Backend, load `.agents/skills/deploy/SKILL.md` (`backend-deploy`). Missing access, tooling, a safe target, or exact-head proof blocks readiness unless Gabriel explicitly authorizes an exception.
- Any later code or infrastructure change invalidates prior dev-smoke evidence. Redeploy and smoke the new exact head before review resumes or another `pi-review` round runs. Documentation, agent/workflow-policy, and other non-deployed changes are exempt.
- While in draft, complete the required dev deploy/smoke gate when applicable, then do the local review with your own subscription (tests/build green, self-review, CI green).
- **Mark it ready only when clean locally** — `gh pr ready <pr-url>` — so the human review is requested against a PR that is actually done, not mid-iteration.
- In the dynamic `/linear-execute` workflow this is automated: the implementer opens the PR as a draft, and the workflow flips it to ready-for-review only when the run is `mergeReady` (review panel PASS + green/verified CI + acceptance gate). A blocked run leaves the PR in draft. The mark-ready step is fail-safe — if the `gh pr ready` write is blocked, the PR stays draft and the run surfaces a manual `gh pr ready` command rather than failing.
- If a PR already exists, do **not** toggle its draft state on a resume — leave it as the author last set it. If authorization confirms it is already non-draft, skip `gh pr ready` and report it ready without a manual-ready warning.

## Updating a branch that is behind the base (before merge)

If `gh pr view <n> --json mergeStateStatus` reports `BEHIND` (branch protection requires up-to-date-with-default before merge):

- **Rebase the ticket's own branch onto the default, then force-push-with-lease** — `git rebase origin/<default>` then `git push --force-with-lease`. This preserves the one-commit-per-ticket invariant. (This is the authorized force-push case: your own ticket branch, to clear BEHIND — not a shared/default branch.)
- **Never do a *merge-in* to update a branch** in a single-commit repo — bare `gh pr update-branch` (default) or `git merge <base>` adds a merge commit that fails an `enforce-single-commit`-style CI check. Two single-commit-preserving ways to clear a BEHIND branch: **`gh pr update-branch <n> --rebase`** (server-side rebase, no local worktree — requires a `gh` new enough to have the `--rebase` flag) or a manual `git rebase <base>` + `git push --force-with-lease`. See the `services-ci-gates` skill for the trycourier/services specifics.
- Rebasing re-triggers the full CI run, so **check `mergeStateStatus` before you push any fix, not just at merge time**: if the branch is already BEHIND, fold the rebase and the fix into a single push so CI runs once instead of twice. (Retro session-2026-07-07-C-18993 #3 — a late BEHIND discovery cost a second full CI cycle.)

## Rebasing onto a fast-moving base (pnpm/nx monorepos)

Rebasing an older ticket branch onto a base that has churned (dep changes, a package-manager migration, mass generated files) hits failure modes a normal rebase does not. Seen live in `trycourier/services` (session-2026-07-09-C-19091):

- **Untracked generated files block the checkout.** Per-project generated `tsconfig.json` (and similar nx/build artifacts) that are gitignored but present on disk make `git rebase`/`git checkout` abort with "untracked working tree files would be overwritten." `git clean -f` them first (destructive → needs explicit user authorization for that scope), or stash. Do NOT `git checkout -f` blind.
- **Re-sync the lockfile after the rebase, before pushing.** If the base migrated package managers or changed deps (e.g. npm→pnpm), your branch's old-era `package.json` additions won't be in the new lockfile and CI fails `ERR_PNPM_OUTDATED_LOCKFILE` — taking build/lint/test/reviewdog down together, which looks like a mass regression but is just the lockfile. Fix: `pnpm install --lockfile-only` (updates `pnpm-lock.yaml` without building), fold it into the rebased commit, then push once.
- **Distrust local green after a rebase.** A stale nx daemon / old-era `node_modules` gives false-green type-aware lint and tests locally (`enforce-module-boundaries`, `no-unnecessary-type-assertion` resolve against stale built `dist`). Do a fresh `pnpm install` (+ `nx reset` / `nx build <lib>` as needed) before trusting a local run; otherwise real findings only appear in CI.
- **Force-push with lease, then verify.** After the rebase, `git push --force-with-lease` (authorized case: your own single-commit ticket branch). Then confirm local `HEAD` == remote — a "behind N" on a single-commit branch means the remote was itself rebased; rebase onto the current base again before amending, or you clobber. (Ties to memory `forcepush-worktree-stale-lease`.)

## Failure recovery

The `docs/context/git-conventions.md` **Failure Recovery** table is authoritative. High-level principles:

- Uncommitted work blocking a checkout / rebase → stash, never discard.
- Merge conflict → resolve, don't discard one side.
- Lock file present → investigate the holding process, don't delete.
- Unfamiliar files / branches → investigate before deleting; they may be the user's in-progress work.

Destructive operations (`git reset --hard`, unpinned `git push --force`, `git checkout --`, `git clean -f`, `git branch -D`) require explicit user authorization **for the specific scope** — previous authorization does not carry over. The verified owned-ticket-branch pinned-lease path above is the narrow routine exception.

## Repo-specific variations

Some sibling repos have extra gates (CI pre-flight, staging validation for release PRs, etc.). The repo's `AGENTS.md` and `docs/context/git-conventions.md` capture those. Always load both before starting work.
