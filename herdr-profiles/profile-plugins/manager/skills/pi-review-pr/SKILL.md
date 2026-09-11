---
name: pi-review-pr
description: Adversarial cross-model review of a GitHub PR or architecture plan/blueprint via the local pi-review CLI driving pi. Use for PR review, cross-model review, second-model review, plan review, blueprint review, or architecture-document review — including GitHub PR URLs, local Markdown files, and Notion blueprint links. Oracle is used only when Gabriel explicitly requests it.
---

# pi-review a PR or ordinary plan

Runs the local `pi-review` CLI (adversarial cross-model harness: agentic finder(s) → semantic dedupe → cold-start refuter → deterministic verdict) against either a GitHub PR or a plan/architecture document. PR mode reviews a disposable detached worktree without touching the current checkout. Plan mode reviews a document against the selected repository's real architecture and implementation context. Oracle is never selected automatically; it requires Gabriel's explicit request for the current task. Source: `~/workspace/pi-review` (README has the model policy and full contract).

## Steps

1. **Preflight**: run `command -v pi-review || echo MISSING`. If missing, report that pi-review is not installed (`ln -s ~/workspace/pi-review/bin/pi-review.mjs ~/.local/bin/pi-review`) and stop.
2. **Choose the mode from the user's actual target**:
   - A GitHub PR number or URL means PR mode: `pi-review pr <number|url>`.
   - A local document, Notion page, blueprint, proposal, RFC, ADR, or explicit request to review a plan means plan mode: `pi-review plan <file...>`.
   - Route to Oracle only when Gabriel explicitly requests Oracle for the current task; risk or criticality alone never authorizes it.
   - A non-GitHub document URL is **not** a malformed PR reference. Do not ask for a PR after the user confirms they want the document reviewed.
   - If it is genuinely unclear whether the user wants implementation or design reviewed, ask once before spending on model calls.
3. **Prepare the target**:
   - **PR mode:** parse the owner/repo, locate its local clone, and run from that clone. In a multi-repo workspace, never run from the workspace root unless it is the repository itself.
   - **Plan mode:** materialize the complete document as a local UTF-8 text or Markdown file. For a Notion blueprint, fetch it through the configured Notion MCP, preserve the full body (headings, tables, diagrams, and decisions), write it to a temporary `.md` file, and verify that the export is nonempty before review.
   - `pi-review plan` must still run inside a Git repository because the reviewers ground design claims against repo code and conventions. Choose the repo that owns most of the proposed implementation. If ownership is ambiguous, ask. For a cross-repo blueprint, state which repo provides the grounding context; if full code-grounded coverage of every repo is required, run separate plan reviews from each repo and report them separately.
4. **Check calibration before spending**: from the selected repo, run `pi-review calibrate status --json`. Both matcher and adjudicator must be `CALIBRATED`. For lifecycle-v3, the final-audit role must also be `CALIBRATED`; if it is missing or stale, run `pi-review qualify --role final-audit --repo-local --write` (or the exact remediation printed by the CLI) before starting the terminal review. The paid fallback route is a separate artifact and is only needed if the operator intends to authorize `--final-audit-fallback`. It requires a configured provider budget and an explicit positive per-call reservation: `pi-review qualify --role final-audit --model openrouter/z-ai/glm-5.3-flash --final-audit-fallback-cost <usd> --repo-local --write`. Never qualify or invoke the paid route without current operator authorization. If any required role is degraded, do not spend on the review.
5. **Run with a long timeout**. Preserve stdout JSON even when exit code 1 means `BLOCKED`:
   ```bash
   out=$(mktemp)
   err=$(mktemp)
   set +e
   pi-review pr <number|url> --json >"$out" 2>"$err"     # PR mode
   # pi-review plan <file...> --json >"$out" 2>"$err"    # plan mode
   rc=$?
   printf 'PI_REVIEW_EXIT=%s\nSTDOUT_JSON=%s\nSTDERR_LOG=%s\n' "$rc" "$out" "$err"
   ```
   The CLI can take 10–20 minutes. Do not kill it early. Optional passthroughs when the user asks: `--roster cheap|default|deep|escalate`, `--no-route`, `--linear <ticket>`, `--models <spec>`, `--fail-on major`, `--no-verify`, and `--context <file>`. `--responses <file>` applies to PR/diff convergence, not ordinary plan review. For an explicitly authorized lifecycle-v3 fallback only, pass `--final-audit-fallback --final-audit-fallback-cost <usd>`; never pass a `:free` audit model.
6. **Interpret exit code**: 0 = PASS/PASS_WITH_NOTES; 1 = BLOCKED; 2 = harness error. For exit 2, read stderr and report the taxonomy/remediation line (`pi-not-found`, `auth`, `timeout`, `parse`, `final-audit-required`, etc.). Do not blindly retry. In plan mode, `BLOCKED` is a design gate asking for revision or an explicit human decision, not a statement about PR mergeability. In lifecycle-v3, a terminal clean report is valid only when `finalAudit.status` is `passed`, its verdict is `PASS`, `convergencePolicy.stop` is false, and the report's exact head/tree/manifest identity is intact.

### Reading a verdict — mandatory

`report.json` is authoritative for what pi-review reported. It is not an automatic must-fix list. Never use a console summary, lane summary, or remembered worker report as the verdict. In the JSON schema, `verification` is an **object**, not a string: status, confidence, and reasoning are nested under it.

Independently question every reported item, including `CONFIRMED` items. Check the claim against the requirements, actual diff, surrounding code, tests, concrete impact, and assigned scope. Classify each item as `must-fix`, `follow-up`, `nit`, `defense-in-depth`, or `not-a-finding`, with a short rationale. Reported severity is evidence, not the final classification. Use `must-fix` only for a real, in-scope correctness, security, data-loss, contract, or acceptance-criteria failure. Do not block on style preferences, optional cleanup, speculative hardening, out-of-scope redesign, or theoretical defense-in-depth without a material threat. Preserve the harness verdict separately so independent judgment never rewrites what the report said.

The wrong check below silently returns zero matches because it compares an object with a string; it can turn a blocked report into a false clean:

```bash
jq '[.findings[]? | select(.verification == "CONFIRMED")] | length' report.json
```

Use the nested fields and inspect the complete status breakdown instead:

```bash
jq '[.findings[]?.verification.status] | group_by(.) | map({status: .[0], count: length})' report.json
jq '[.findings[]? | select(.verification.status == "CONFIRMED")]' report.json
jq '.stats.costUsd' report.json
```

The cached report path is keyed by repository **or worktree** name. Use the report path printed on stderr, or glob the repository/worktree key rather than assuming the repository directory name. To identify the same run, match its `headSha`, session, invocation, and cost against the command context and stderr report path. Never declare a clean verdict until the verified-item counts and the top-level verdict agree; an empty result from the wrong jq shape is not evidence of cleanliness.

7. **Report from the JSON without promoting refuted candidates**:
   - Verdict and one-line meaning. Include PR number/title/author in PR mode; include the document title and grounding repo in plan mode.
   - Verified findings only: items whose verification is `CONFIRMED` and worth reporting. Include severity, title, `file:line`, refuter confidence, one sentence of refuter reasoning, and your independent classification with rationale. A confirmed item may still be a follow-up, nit, defense-in-depth suggestion, or not a real finding.
   - Report `notes[]` briefly.
   - Count refuted candidates separately. Also report ledger-suppressed/dismissed items separately when present. Plan-mode JSON may retain refuted candidates in `findings[]`; never present them as verified findings.
   - Footer: cost (`stats.costUsd`), duration, and the report path printed on stderr (`~/.cache/pi-review/...`). For lifecycle-v3 also report `convergencePolicy` stop/anomaly counts, `convergenceDiscovery` completeness/novelty, and the `finalAudit` status/model. Never summarize a `BLOCK` audit as a clean review.
   - If the user confirms a false positive, offer `pi-review dismiss <id> --reason "..."` where the mode supports the dismissal ledger.

## Plan and blueprint comments

An ordinary plan review is read-only by default. Never post comments to Notion, Google Docs, Linear, GitHub, or another source unless the user explicitly asks in the current session.

When the user asks to post inline comments on a Notion blueprint:

1. Fetch existing discussions first so you do not duplicate an open thread.
2. Post only confirmed, worth-reporting findings and useful notes. Do not post refuted candidates.
3. Rewrite harness language into short, natural engineering feedback while preserving the exact technical claim. State the failure mode and ask for the missing decision or mitigation.
4. Anchor each comment to the most relevant sentence or reply to an existing discussion on that sentence. Do not dump the whole report into a page-level comment.
5. Report which comments were posted and which candidates were intentionally omitted.

## Hard rules

- **Never post PR comments, reviews, approvals, or plan-document comments unless the user explicitly asks in the current session.** Reading is fine; writing to GitHub, Notion, or another source is a separate user-initiated action. For a GitHub PR comment, use `gh pr comment <n> --body-file <outdir>/comment.md` with the artifact written next to `report.md`.
- Never modify the PR branch or local checkout. `pi-review pr` works in a disposable worktree by design; `pi-review plan` is also review-only and must not rewrite the source document.
- Findings come from the report verbatim. Do not add your own findings to the pi-review findings list. If asked for your own opinion, separate it clearly.
- Serialize `pi-review` runs within one repository. The repository-wide `protocol.lock` can reject contention during any journal transaction, including after model work, so same-repository concurrency can waste spend and abort a review. Reviews in different repositories may run concurrently.

## Re-review loops (fix → re-run → repeat)

This section and the convergence protocol below apply to PR/diff sessions, not ordinary plan mode. A plan review is a soft design gate: revise the document or record the human decision, then run another plan review only when the user asks.

When the user wants iterative PR hardening ("fix all issues before merge-ready"), you run pi-review, fix, push, and re-review across rounds. Three lessons from doing this badly (C-19094, 8 rounds):

- **Dismiss user-ACCEPTED trade-offs, don't just false positives.** Once the user accepts a finding as out-of-scope / won't-fix / a documented trade-off (e.g. an atomicity trade-off they chose), run `pi-review dismiss <id> --reason "…"` immediately. Otherwise the finder re-derives it from the diff and re-reports it as "confirmed critical" every round — C-19094 re-litigated one accepted finding across 3 rounds for want of a dismiss. Dismiss is for anything you will not act on, not only refuted items.
- **Codify a STOP rule up front.** "Fix all issues" is not "loop until PASS" — adversarial review on complex infra keeps surfacing progressively marginal/defensive/other-ticket-scope items and never terminates. Agree a stop rule with the user early (AskUserQuestion): **stop when the only remaining confirmed findings are refuted, minor-style, an accepted trade-off, or another ticket's scope** — then file the residuals as follow-up tickets. Fix genuine in-scope correctness/security; don't chase the tail.
- **Pin the roster on the deep route to avoid a flaky reviewer.** The `deep` route can add a diff-only reviewer that crashes the harness (`RangeError: Invalid string length`, unbounded stdout) or a reviewer that exceeds the per-reviewer cap (`[timeout]`), both yielding no verdict. For a clean re-review, pin the currently admitted codex reviewers only: `--models "openai-codex/gpt-5.6-sol:high,openai-codex/gpt-5.6-luna:high"`. Terra is retired and must not be reintroduced. The reserved GLM final-audit candidate is not a finder override. (Background Bash runs are not killed at the foreground `timeout`, so a multi-minute run completes even with a 600000ms tool timeout.)

## Lifecycle-v3 convergence and terminal audit

Lifecycle-v3 reports carry three bounded evidence fields: `convergenceDiscovery`,
`convergencePolicy`, and (on terminal full reviews) `finalAudit`. Treat
`convergencePolicy.stop: true` and any anomaly as an immediate stop; do not retry to
make the warning disappear. The policy stops on: incomplete, truncated, or uncovered
discovery coverage; a missing manifest; an unresolved critical/major thread (judged on
the immutable `sourceSeverity`, so a downgrade to minor does not clear it); a round
whose net closure is non-positive while work is still unresolved; a thread that took
two or more evidence-changing responses without closing; the same evidence judged
unresolved twice; a disposition reversal on identical evidence; and a conflict between
a thread's immutable provenance and its projected severity or population. The last
four mean the loop is not converging — file the residual and stop, do not re-run. A clean terminal report must have
`finalAudit.status: "passed"`, `finalAudit.verdict: "PASS"`, zero audit anomalies,
`convergencePolicy.stop: false`, and exact matching `headSha`, reviewed tree, and
coverage-manifest identity. `PASS` with an anomaly is invalid and is converted to
`BLOCKED`/`needsUser`.

The audit primary is exactly `opencode-go/glm-5.3-flash` at high thinking and is
qualified separately with the bundled 16-case production-shaped dataset. A passing
artifact requires 16/16 parseable, exact decisions with zero false positives or false
negatives and positive coverage of every audit anomaly code. Each route is qualified
on its own: `pi-review qualify --role final-audit --write` covers the primary. The paid
`openrouter/z-ai/glm-5.3-flash` route needs its own artifact, a configured provider
budget, current operator authorization, and an explicit positive reservation:
`pi-review qualify --role final-audit --model openrouter/z-ai/glm-5.3-flash --final-audit-fallback-cost <usd> --write`.
A paid fallback without that artifact does not run at all — the audit records
`status: "failed"` naming the missing paid-fallback qualification. The fallback is
never automatic either: use it only when the operator explicitly authorizes
`--final-audit-fallback --final-audit-fallback-cost <usd>`.
`finalAudit.route`/`finalAudit.provider` name the route that actually answered, and
`finalAudit.qualificationConfigurationHash` is that route's artifact, never the
primary's. Never substitute a `:free` alias and never use `--models` to select the audit.
Activation of lifecycle-v3 invalidates active sessions that predate policy version 1;
it does not migrate their evidence. That activation stops the run that triggered it:
an unbound admission reports `lifecycle-v3-new-session-required` naming the invalidated
session. Do not retry to make it go away and do not invent a new session — report the
invalidated session id to the operator. Only with their explicit instruction, rerun with
`--new-session-after-invalidation <that-session-id>`; the previous session's evidence is
abandoned, not carried over. If the CLI reports `final-audit-required`, preserve the
report/diagnostic and stop for operator action: the harness has already written a
blocked diagnostic report (verdict `BLOCKED`, the `finalAudit` record, the attempted
calls, the stage duration, and the spend) and a `runs.jsonl` entry, so read those and
report the audit status and failure code rather than re-running the review.

## Convergence protocol: closing threads

pi-review runs a **convergence protocol**: every finding becomes a durable *thread* that is re-listed and re-gates the verdict on EVERY subsequent invocation until it is explicitly terminated. Fixing the code and re-running `pi-review pr` is **not** enough — the finder just re-derives the same defect (or a ledger artifact of it) and the verdict stays `BLOCKED`. A thread terminates only via one of: (a) an implementer **bundle response** (`fixed`/`rebut`) that the adjudicator accepts; (b) the verifier refuting a matched candidate; (c) a matched ledger `pi-review dismiss <id> --reason`.

**After you fix findings and push, submit responses — do not just re-run.** This is the leg the fix→re-run loop is missing when threads never close.

- **`dismiss` vs bundle response — pick by intent.** `pi-review dismiss <id> --reason` is for items you will **not act on**: false positives, accepted trade-offs, out-of-scope. Responses are submitted through a `schemaVersion: 2` `--responses <file>` bundle and are for items you **did act on**: `fixed` (you changed the code) or `rebut` (you argue it's a non-issue with rationale). Close a genuinely fixed finding with a `fixed` bundle response, **not** a dismiss — dismiss suppresses the finding in the ledger, so a future real regression on that code would be masked.

- **Submit responses with `--responses <file>`** (from a checkout of the PR branch whose HEAD is the fix commit):
  ```
  pi-review diff --responses responses.json
  # or: pi-review pr <number> --responses responses.json
  ```
  - The envelope is `schemaVersion: 2` and contains one or more coherent bundles. Each bundle declares `bundleId`, `kind` (`fixed` or `rebut`), `threadKeys`, root cause, intended invariant, expected changed dependencies, validation evidence, and per-thread `responses[]`.
  - Every report footer prints a skeleton with the exact session, invocation, head, thread keys, and revisions. Validation runs before any model call, so malformed input costs ~$0 and appends nothing.
  - `fixed` responses require a clean checkout and a commit descending from the reviewed head unless `--rebased` explicitly acknowledges rewritten history. A `rebut` response declares no changed dependencies.
  - Re-run the review once to adjudicate the recorded responses. Recording is cheap; only the adjudication run costs model calls.

- **Lineage / descent gate.** A `fixed` response requires the checked-out HEAD to equal `commit`, and by default `commit` must **descend from** the reviewed head. **If the branch was rebased/force-pushed after the reviewed round**, the strict check rejects (`fixed response commit must descend from envelope headSha`) — pass `--rebased` to acknowledge the rewrite explicitly (HEAD==commit and clean-tree anchors still apply). Prefer responding before rebasing; `--rebased` is the operator escape hatch. A `--wontfix`/rebut response anchors to the **reviewed** head — issue it from a detached worktree at that commit (`git worktree add --detach <tmp> <reviewedHead>`) if the branch has moved.

- **Closed threads stay closed.** A re-derived finding that matches an already-terminal thread no longer reopens it or gates the verdict — it appears under a non-gating `## Reopen candidates` heading with a copy-pasteable command. Reopening is a deliberate human act: `pi-review threads reopen <key> --session <id> --expected-revision <n> --reason "..."`. Same-session rematches of closed themes are suppressed (`session-closed-thread`) so late rounds stop re-litigating.

- **Disputes terminate via escalation.** If the adjudicator keeps countering a response the user has accepted as a trade-off (a `wontfix` it won't agree to), don't loop: `pi-review threads escalate --session <id> --invocation <id> --thread <key> --expected-revision <n> --reason "..."`, then `pi-review threads resolve <key> --session <id> --expected-revision <n+1> --outcome wontfix --reason "..."` — human authority ends the thread as `agreed-wontfix`.

- **Freeze the branch while a run is in flight.** Amending, rebasing, or force-pushing the reviewed branch mid-run kills the run with `ERROR: reconcile headSha mismatch` and its model spend is lost (aicodeflow 2026-07-23: an amend during round 5 wasted the whole round). Land every commit BEFORE launching, and queue further edits until the report returns.

- **Ops notes.** Serialize all `pi-review` operations within one repository; different repositories may run concurrently. Check semantic-matching health with `pi-review calibrate status` (matcher + adjudicator must show CALIBRATED; artifacts live machine-wide in `~/.local/share/pi-review/calibration/`); a degraded role warns on stderr at run start with the exact `pi-review calibrate protocol --role <role>` remediation — calibrate before spending on a review, since without the matcher, drifted threads can't close and dismissal suppression narrows to exact-id.

- **Failure mode observed 2026-07-16 (why this section exists).** Two PRs were fixed and re-run without ever submitting responses. Every following invocation re-listed the same threads and stayed `BLOCKED` — the verdict was gated on stale thread artifacts, not live code findings, and a post-fix rebase then blocked the responses path too (this predated `--rebased`).

- **The clean-tree anchor rejects untracked AND ignored files, not just tracked changes (C-19381).** A `fixed` bundle response fails on build outputs, caches, or unrelated untracked files because the check wants a PRISTINE tree. Local agent-state dirs (`.aicodeflow/`, `.claude/`, `.codex/`, `.pi/`, `.pi-review/`, `.worktrees/`) are exempt. For everything else, **submit `--responses` from a throwaway pristine checkout:** `git worktree add --detach <tmp> <fixCommit>` (a fresh checkout has no `node_modules`/caches), run the bundle response there, then remove it. This composes with `--rebased` when the branch was force-pushed.

- **The response-ledger adjudication can crash the run — recognize the floor, don't loop (C-19381).** A batched `fixed`-response adjudication (15 threads) died mid-run with `ERROR: agreed-wontfix accepted only for a rebut response` after processing ~8 threads, leaving no report. This is the convergence protocol diverging into a tooling fault, not a code signal — and by then the finders had already dropped from 10→5, i.e. the code had converged. **When the protocol crashes or keeps re-listing after genuine fixes, stop looping pi-review to a green PASS.** Finalize via the PR's actual required gate instead (for a trycourier/services yellow-risk PR that is a Claude approval: post `/claude-review` as a PR comment, which independently reviews the final code). Escalate/resolve stuck threads with `pi-review threads resolve … --outcome …` only if you must keep the session; otherwise the required gate is the authoritative convergence check.

## Lessons 2026-08-27

- Run `pi-review check` before closing threads by human authority. Escalating or resolving first stales
  pending `fixed` responses and makes `check` exit 2 with `stale revision`.
- `threads escalate` requires the full invocation id, not an abbreviated id.
- Run `check` in the background with a timeout of at least 10 minutes; valid checks can take more than
  five minutes.
- Never use `pkill -f` with a pattern that matches the command line running `pkill` itself.

## Lessons 2026-08-25

- In zsh, capture the review process result as `rc=$?`; `status` is read-only and can make a valid
  review wrapper fail before it records the report.
- Before every paid round, run `git fetch origin` in the runner clone; a stale base checkout can turn
  unrelated base changes into out-of-scope findings.
- `threads escalate` must bind to the invocation that **exposed** the thread, never a later `check`
  invocation (which is stale for escalation).
- `check` costs $0 but cannot adjudicate `fixed` responses. Close those through a paid round, or after
  escalation use human `threads resolve --outcome fixed|wontfix` as appropriate.
- **Three rounds is the ceiling and there is no override.** `--override-round-limit` was removed; at
  the ceiling the CLI spends nothing and returns `BLOCKED`/exit 1 with the unresolved threads. Apply
  only the round-three confirmed fixes, run no fourth review, keep the `BLOCKED` verdict as recorded,
  and continue under the owner's fix-and-waive decision (`courier-pr-gates`, "pi-review round ceiling
  reached"). The model-free `verify`/`check` paths and human `threads escalate|resolve` are the only
  ceiling moves; `--override-abandoned-attempts` lifts a different limit and charges no round.
- When a finding is re-derived, dismiss it by the current candidate id printed in the report warnings,
  not by a stale thread or id-only reference. For out-of-scope work, use reason `tracked as <ticket>`.
- After the substantive review, when no response needs adjudication, run `pi-review check pr <n>` as
  the cheap `$0` final sweep and take the verdict only from that run's authoritative `report.json`.
- Never close, retire, or replace a pane while its `pi-review` process is running. Read the transcript,
  confirm the process has produced `report.json`, and only then perform cleanup.

## Lessons 2026-09-03 (MV4 front: B/C/D rounds, human closure, qualification)

- **`--responses <bundle>` records AND immediately starts a paid round.** Recording is not separable from adjudication; a fix lane told to "record only" must NOT invoke it — validate the bundle from a pristine detached checkout and hand the path to the manager, who runs `pi-review pr <n> --responses <bundle>` as the next round.
- **Response/bundle ids must be unique per repo.** Generic `thread-N` ids from the footer skeleton collided across PRs (`responseId already used with different content: thread-1-1`). Prefix `<ticket>-r<n>-…`. (Upstream fix: ids namespaced by session/invocation/thread/index since pi-review main `001127f`.)
- **`threads escalate --invocation` = the invocation that produced the thread's CURRENT revision** (the latest review round that re-listed it), not the round that first exposed it — the earlier invocation is rejected as `stale invocation for escalation`.
- **Human-closure sequence (owner-authorized closure without a paid round):** `pi-review check pr <n>` ($0) → for each gating thread `threads escalate … --expected-revision <current>` then `threads resolve <key> --expected-revision <current+1> --outcome fixed|wontfix` (never call a refuted claim "fixed" — use `wontfix` with "refuted by test <spec>") → final `check`. `NEEDS_SWEEP` with zero gating threads is the protocol tail; a "reopened-pending-verification" thread still gates until resolved.
- **Stacked PRs need no flag:** `pi-review pr <n>` diffs against the PR's own base branch (`Mode: diff (base: <branch>)`), so a PR based on another PR branch is already scoped.
- **Pristine checkout means no node_modules either**; use `git worktree add --detach /tmp/<x> <sha>`; the report cache is keyed by that checkout's directory name but the session follows the PR — the same session id continues.
- **A closed-by-human session has zero "responded" threads** — it cannot feed `qualify --role batch-verifier --record`.
- **The batch verifier IS the adjudicator seat** (`cfg.adjudicator`): re-seating it changes production single-thread adjudication, drifts the adjudicator calibration (terminal decisions disabled until `calibrate protocol --role adjudicator` re-runs its 40-case corpus), and qualification is per repository. ADR-0007 R3 refuses any sample group containing a thread found by the same model → with luna as adjudicator, only sessions whose finders were sol-only (post-ADR-0008) can qualify. `glm-5.3-flash` routes are reserved for the lifecycle-v3 final audit; deepseek-v4-flash is in the finder corpus and refused for core seats.
- **Advisory seats can kill a paid run**: `remediation-bundle-advisor … parser-failure` aborted a round before report.json (fixed in `001127f`: fails open). Until the fixed binary is what PATH resolves (`~/.local/bin/pi-review` → main), `remediationBundles.mode="off"` is the workaround.
- **Round cap with a non-converging finder** (6→3→4, 12→4→8, 13→5→7 confirmed across three rounds while every prior thread resolved): the cap is a signal about the defect population, not the review. No extra round is purchasable, so the option set is: fix-and-waive (the owner's standing 2026-09-04 decision — round-three confirmed fixes only, `BLOCKED` kept as recorded, the pi-review gate owner-waived, `/claude-review` on the final head as the reading gate); fix-and-human-close via `threads escalate|resolve`; a design-level hardening pass on a fresh session; or hold. Bring it with costs and the residual risk named.
- **Companion gate quirks:** the reusable `claude-pr-review` workflow skips DRAFT PRs silently (run "success", zero objects) — mark ready first; it produced no review body twice on a 16.7k-line single-commit diff (C-20484) — a yellow-tier PR then needs an owner-decided substitute gate.

## Lessons 2026-09-03 (SQS front: stale base refs, admitted models, quota)

- **Before every round, sync the LOCAL base branch.** `pi-review pr` grounds the diff against the clone's local `staging`, not `origin/staging`. In the runner clone (and in the parent clone of any pristine worktree you use for `--responses`): `git fetch origin staging:staging` then verify `git rev-parse staging` equals `git rev-parse origin/staging`. Stale refs admitted merged-sibling hunks as CONFIRMED findings on two PRs and burned a round each; dismiss such artifacts by their current candidate id with reason "not in PR diff; stale local staging grounding".
- **Admitted models are configuration.** `--models` ids must be active in pi-review's configuration (`~/workspace/pi-review/src/config.mjs`; "invalid reviewer[0] model (… is not active in any configuration)" is a pre-spend rejection). Verified 2026-09-03: `opencode-go/deepseek-v4-flash` works as a full-diff finder (~$0.06/round); `opencode-go/glm-5.3-flash` is the reserved independent final-audit model (ADR-0010) and must NOT be seated as a finder; the Cursor Opus route (`cursor/claude-4.6-opus[-thinking]`) emits output the strict finder parser rejects; matcher and adjudicator are calibrated on `openai-codex/gpt-5.6-luna:high` — changing their id decalibrates them (a Codex quota hit there needs an owner decision, not a config edit).
- **Codex usage limits surface as parse errors.** A finder trace ending in `"stopReason":"error","errorMessage":"Codex error: The usage limit has been reached"` produces `[parse:<model>] unparseable reviewer output after retry` (exit 2). Read the trace dir before retrying.
- **Abandoned-attempt ceiling.** After three aborted attempts in a session the CLI requires `--override-abandoned-attempts "<reason>"`; the reason must state the real attempt count and any spend — do not reuse a reason written before a paid attempt.
- **Concurrent runs.** Never run concurrent operations within the same repository. The repository-wide lock may contend after model work, so serialize PR, plan, and session operations rather than relying on retry. Different repositories may run concurrently.

## Lessons 2026-09-06 (fixed bundles)

- `responses.rN.json`: `headSha` = the reviewed round's head; every `bundles[].commit` = the current PR head; `expectedRevision` from the last report. Mix-ups fail pre-spend: `response headSha mismatch`, `fixed response commit must descend from envelope headSha`. Write the bundle after the last amend.
- Copy `reviewSessionId` and `reviewInvocationId` byte-for-byte from the authoritative previous `report.json`. `reviewInvocationId` must be the full UUID, never the 8-character display prefix. A prefix passes casual inspection but fails pre-spend with `response session/invocation mismatch`. Before invoking, compare both fields for exact equality against the previous report, not with `startswith`.
- Each bundle's `rootCause`, `intendedInvariant`, and `validationEvidence` is capped at 2,000 characters. Validate those lengths before invoking. A larger field fails pre-spend, so do not rely on JSON/schema shape alone.
- Rebased since the last round → `--rebased`. The session is keyed per PR number, so a retargeted stacked PR keeps its rounds.
- Unchanged thread text across rounds is persisted text, not a missed read (`traces/adjudicator-*.jsonl`). Before re-fixing a still-open thread, get file:line proof at the reviewed head.
- Runner clone with `staging` checked out: `git pull --ff-only origin staging` before each run.

## Lessons 2026-09-09 (multi-repo, response rounds, closure state)
- The pinned CLI has NO `--repo` flag; the repository is inferred from the cwd's git remote — run from a clean checkout of the target repo (e.g. a `services-review-runner` clone), never from an author worktree. Two lanes lost a run each to `--repo`.
- Response bundles use the ROUND-1 review session + invocation ids (the round that opened the thread), not a later round's; thread escalate/resolve commands fail with `session/invocation mismatch` on the wrong pair. `pi-review check` is attach-only.
- `NEEDS_SWEEP` with zero findings after a response round is the expected closure state under ruling #89 (one round is the gate for config PRs) — record it, do not run a paid sweep.
- One host review slot across ALL workspaces on the machine: check `ps` for a live `pi-review` before starting; a queued lane sitting `done`/idle between waits is not stale.
- Standing brief clauses: author/fix lanes never run `pi-review`; review lanes never push; a confirmed finding on a file the PR does not touch is dismissed as out of scope and filed as a follow-up ticket with AC.

## Lessons 2026-09-10
- `check` (the `$0 check`) is **attach-only and its session store is per runner clone**: run it from `backend-review-runner` / `services-review-runner` after `git fetch origin staging:staging`; from a worktree it reports "requested session does not exist in this repository".
- Exit 2 with `Post https://api.github.com/graphql … i/o timeout` is a network fault, not a harness or PR problem: probe `curl -s -m 8 https://api.github.com/`, wait ~5 min, retry once; do not burn the harness re-run on it.
- A response-first round can keep round-1 threads **still-open on stale evidence** even when the fixed head no longer has the cited code (its re-verification quotes round-1 file:line). Do not spend a third round: human-close with file:line proof at the final head + `$0 check` (`--rebased` after an amend).
