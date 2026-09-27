---
name: pi-review-pr
description: Adversarial cross-model review of a GitHub PR or architecture plan/blueprint via the local pi-review CLI driving pi. Use for PR review, cross-model review, second-model review, plan review, blueprint review, or architecture-document review — including GitHub PR URLs, local Markdown files, and Notion blueprint links. Oracle is used only when Gabriel explicitly requests it.
---

# pi-review a PR or ordinary plan

Runs the local `pi-review` CLI (adversarial cross-model harness: routed finder
preset → semantic dedupe → cross-family refuter chain → advisory verdict)
against either a GitHub PR or a plan/architecture document. PR targets are
reviewed in a disposable detached worktree without touching the current
checkout. Plan targets review a document against the repository's real
architecture and implementation context — the finder sees the materialized
HEAD tree, never the live checkout. Oracle is never selected automatically; it
requires Gabriel's explicit request for the current task. Source:
`~/workspace/pi-review` (`next/README.md` has the model policy and full
contract).

## Steps

1. **Preflight**: run `command -v pi-review || echo MISSING`. If missing,
   report that pi-review is not installed and stop. The binary is the
   TypeScript rewrite — the owner installs it with
   `ln -sfn ~/workspace/pi-review/next/bin/pi-review-next.ts ~/.local/bin/pi-review`.
   Requires Node >= 24.19 and native Linux `flock`; a host without flock fails
   closed with a typed error.
2. **Choose the target from the user's actual input** — one positional
   `[target]` covers every mode:
   - A GitHub PR number, `#N`, or PR URL: `pi-review <number|#N|url>`.
   - A local document, Notion page, blueprint, proposal, RFC, ADR, or explicit
     request to review a plan: materialize it as a local file, then
     `pi-review <file>`.
   - No target: the current branch's committed change against its resolved
     base (one `gh` lookup for an open PR, else `origin/<default>` — the
     fallback is disclosed in the report as a `base-fallback` gap).
   - An existing file path wins over a PR number, so a file literally named
     `123` is reviewed as a plan.
   - Route to Oracle only when Gabriel explicitly requests Oracle for the
     current task; risk or criticality alone never authorizes it.
   - A non-GitHub document URL is **not** a malformed PR reference. Do not ask
     for a PR after the user confirms they want the document reviewed.
   - If it is genuinely unclear whether the user wants implementation or
     design reviewed, ask once before spending on model calls.
3. **Prepare the target**:
   - **PR target:** parse the owner/repo, locate its local clone, and run from
     that clone (`pi-review` needs `gh` for PR identity). In a multi-repo
     workspace, never run from the workspace root unless it is the repository
     itself. The head is fetched, verified against `gh`'s `headRefOid`, and
     reviewed in a locked disposable detached worktree that is removed
     afterwards.
   - **Plan target:** materialize the complete document as a local UTF-8 text
     or Markdown file. For a Notion blueprint, fetch it through the configured
     Notion MCP, preserve the full body (headings, tables, diagrams, and
     decisions), write it to a temporary `.md` file, and verify that the
     export is nonempty before review. Document bytes up to 512 KiB are
     embedded whole, never truncated.
   - A plan review must still run inside a Git repository because the finders
     ground design claims against repo code and conventions. Choose the repo
     that owns most of the proposed implementation. If ownership is ambiguous,
     ask. For a cross-repo blueprint, state which repo provides the grounding
     context; if full code-grounded coverage of every repo is required, run
     separate plan reviews from each repo and report them separately.
4. **Run with a long timeout.** Routing plus the finder legs share one
   1200 s window; the refuter phase gets another 1200 s — a round can take
   tens of minutes. Do not kill it early. Preserve stdout JSON at every exit
   code — the report is emitted and persisted even at exit 1:
   ```bash
   out=$(mktemp)
   err=$(mktemp)
   set +e
   pi-review <number|url|file> --json >"$out" 2>"$err"
   rc=$?
   printf 'PI_REVIEW_EXIT=%s\nSTDOUT_JSON=%s\nSTDERR_LOG=%s\n' "$rc" "$out" "$err"
   ```
   The only user-facing option besides `--json` is `--context <file>`
   (repeatable) — a judge-supplied requirements file. Put ticket acceptance
   criteria or review constraints there. Model seats, presets, thresholds, and
   timeouts are not configurable per run: the Jev router picks the preset
   once per generation, and phase windows are fixed.
   `-m <reply>` (reply to the latest completed round — see "Re-review loops")
   and `--fresh` (retire the generation and restart at round 1) also exist;
   `-m` and `--fresh` cannot be combined. Quota preflight runs once per round
   before the finders; its advisories are stderr warnings. A seat actually
   served by the same-model opencode-go fallback (GLM and Luna seats only) is
   disclosed in the report as a `finder` gap, and `findings[].finder` names
   the route that answered.
5. **Interpret exit code** (there is no gating verdict — pi-review is an
   advisor, per ADR-0016):
   - `0` = the round completed. Read `verdict`: `clean` or `findings`. A
     `findings` verdict at exit 0 still carries open findings — judge them.
   - `1` = `incomplete` or failed (interrupted round, post-capture drift,
     provider/phase failure). The report is still emitted and persisted with
     the findings and spend that landed; treat it as partial evidence, not a
     verdict.
   - `2` = usage error. Read stderr and fix the invocation; do not retry
     unchanged.

### Reading a report — mandatory

The `--json` report (`schemaVersion: 3`) is authoritative for what pi-review
reported. It is not an automatic must-fix list. Reports live only in review
state: stdout on a run, or `pi-review show [target] [--json]` afterwards —
`show` is fully offline (no `gh`, no base lookup, no model calls) and is the
one way to re-see a report.

```bash
jq '.verdict' report.json
jq '[.findings[].status] | group_by(.) | map({status: .[0], count: length})' report.json
jq '[.findings[] | select(.status == "open" and .refuter.held == true)]' report.json
jq '.costUsd' report.json
```

- `verdict`: `clean` | `findings` | `incomplete`.
- `findings[]`: `id` (`F1`, `F2`, … — what `dismiss` takes), `status`
  (`open` | `refuted` | `fixed` | `withdrawn` | `dismissed`), `severity`
  (`critical` | `major` | `minor`), `lens`, `file`, `line`, `title`, `detail`,
  `finder`, and `refuter` (`{model, held, reasoning}` or null).
- A finding that survived refutation stays `open` with
  `refuter.held: true`; `held: false` means the refuter refuted it and the
  status is `refuted`. `refuter` may also be `null` on an `open` finding that
  went unrefuted. `open` is the field that corresponds to the old "verified"
  concept — still apply your own judgment.
- `gaps[]` records what the round may have missed (`finder`, `router`,
  `truncated`, `base-fallback`, `error` with stage
  `snapshot|materialize|diff|store|executor`).
- `costUsd` is the round's spend; `null` means unknown — never reported as 0.
- `review{repo,branch,pr,round,preset,head,tree}` identifies exactly what was
  reviewed. `review.attention: "human-decision"` appears from round 4 on —
  advisory data that the loop has gone long, never a gate.

Independently question every reported item, including `open` items. Check the
claim against the requirements, actual diff, surrounding code, tests,
concrete impact, and assigned scope. Classify each item as `must-fix`,
`follow-up`, `nit`, `defense-in-depth`, or `not-a-finding`, with a short
rationale. Reported severity is evidence, not the final classification. Use
`must-fix` only for a real, in-scope correctness, security, data-loss,
contract, or acceptance-criteria failure. Do not block on style preferences,
optional cleanup, speculative hardening, out-of-scope redesign, or
theoretical defense-in-depth without a material threat. Preserve the harness
verdict separately so independent judgment never rewrites what the report
said. An empty jq result from the wrong shape is not evidence of cleanliness —
check the status breakdown, not a guessed field.

6. **Report from the JSON**:
   - Verdict and one-line meaning. Include PR number/title/author for a PR
     target; the document title and grounding repo for a plan target.
   - Open findings worth reporting: severity, title, `file:line`, the refuter
     model and one sentence of its `reasoning`, and your independent
     classification with rationale. A finding whose refuter did not hold may
     still be worth a follow-up — report refuted/fixed/withdrawn/dismissed
     counts separately.
   - Execution: report the preset the router actually chose
     (`review.preset`), the finder seats named in `findings[].finder`, and any
     `gaps[]` — say "not run" for missing coverage rather than guessing.
   - Footer: `costUsd`, `durationMs`, round number (`review.round`), and
     `review.head`/`review.tree` identity. There is no report file path —
     cite `pi-review show` for re-reading.
   - If the user confirms a false positive or accepts a trade-off, offer
     `pi-review dismiss F<n> <reason> [target]` — the reason is positional.

## Plan and blueprint comments

An ordinary plan review is read-only by default. Never post comments to
Notion, Google Docs, Linear, GitHub, or another source unless the user
explicitly asks in the current session.

When the user asks to post inline comments on a Notion blueprint:

1. Fetch existing discussions first so you do not duplicate an open thread.
2. Post only confirmed, worth-reporting findings and useful notes. Do not
   post refuted candidates.
3. Rewrite harness language into short, natural engineering feedback while
   preserving the exact technical claim. State the failure mode and ask for
   the missing decision or mitigation.
4. Anchor each comment to the most relevant sentence or reply to an existing
   discussion on that sentence. Do not dump the whole report into a
   page-level comment.
5. Report which comments were posted and which candidates were intentionally
   omitted.

## Hard rules

- **Never post PR comments, reviews, approvals, or plan-document comments
  unless the user explicitly asks in the current session.** Reading is fine;
  writing to GitHub, Notion, or another source is a separate user-initiated
  action. For a GitHub PR comment, use `gh pr comment <n> --body-file
  <outdir>/comment.md` with the artifact written next to your captured report.
- Never modify the PR branch or local checkout. PR targets are reviewed in a
  disposable locked worktree by design; plan targets are review-only and must
  not rewrite the source document.
- Findings come from the report verbatim. Do not add your own findings to the
  pi-review findings list. If asked for your own opinion, separate it clearly.
- Serialize `pi-review` runs within one repository: every run takes the
  per-review `review.lock` flock, and a second concurrent run is rejected.
  Reviews in different repositories may run concurrently. `show` takes no
  lock.

## Re-review loops (fix → re-run → repeat)

Reviews are multi-round and rounds work by rerunning the same command: a
pending round resumes, a completed round's successor rechecks. A recheck
diffs the last completed reviewed tree → the current tree — never merge-base
or ancestry, so a rebase keeps the delta — and the routing outcome is fixed
for the generation, so later rounds spend no router call. There is no
per-finding response or adjudication protocol: a finding stays `open` until
the code change refutes or fixes it on a recheck (`status: fixed`/`refuted`),
the finder withdraws it, or a human dismisses it.

- **Reply with `-m <reply>`**: sends your text into the next round's recheck
  prompt for every finder — this is how you rebut a finding, explain intent,
  or point at evidence. A reply before any completed round is a usage error.
- **Dismiss what you will not act on** — including user-ACCEPTED trade-offs,
  not just false positives. Once the user accepts a finding as out-of-scope /
  won't-fix / a documented trade-off, run `pi-review dismiss F<n> <reason>`
  immediately (C-19094: one accepted finding was re-litigated across 3 rounds
  for want of a dismiss). Dismissal binds the finding to the reviewed blob
  fingerprint of its file (for a plan target, the document's sha256): the
  claim stays suppressed while the fingerprint is unchanged — and while the
  file is deleted — and re-raises under its own id only when that blob
  changes. Repeating the same dismissal with the same reason is idempotent.
  Each new dismissal is also ingested into the repository's resolved
  Hindsight bank; a missing bank or failed ingest is a stderr note only — the
  local dismissal still applies and the stored report is never mutated.
- **Codify a STOP rule up front.** "Fix all issues" is not "loop until
  clean" — adversarial review on complex infra keeps surfacing progressively
  marginal items. Agree a stop rule with the user early: stop when the only
  remaining `open` findings are minor-style, an accepted trade-off, or
  another ticket's scope — then file the residuals as follow-up tickets.
- **The soft round limit is data, not a flag.** From round 4 the report
  carries `review.attention: "human-decision"`. The standing owner policy is
  three rounds then stop (see `courier-pr-gates`): apply the round-three
  fixes, keep the recorded `verdict` honest, and continue under the owner's
  fix-and-waive decision.
- **Freeze the branch while a run is in flight.** Amending, rebasing, or
  force-pushing the reviewed branch mid-run is drift after capture and ends
  the round `incomplete` at exit 1 with its spend lost. Land every commit
  BEFORE launching, and queue further edits until the report returns.
- **`--fresh` is the reset.** It finalizes any pending round `incomplete`
  and starts a new generation at round 1 — new routing outcome, new
  per-finder sessions, F-numbering reset; the retired generation's data is
  untouched. Use it when the review's premise changed, not to retry a round.
- **Interrupted rounds resume.** A killed or interrupted round re-dispatches
  only unfinished work; finished legs replay, never re-spend.

## Capability losses to know about

The rewrite deliberately dropped the old tool's per-finding conversation
protocol and seat control. Workflow replacements:

- Rebutting or appealing a finding → `-m <reply>` (goes to all finders next
  round) or `dismiss` for items you will not act on. There is no per-finding
  response channel.
- "Cheap final sweep" → `pi-review show [--json]` re-reads the last report
  for free, but there is no free re-adjudication: any new evidence requires a
  real round.
- Seat/preset selection → none exists. The Jev router picks the preset once
  per generation; if a finder seat misbehaves there is no pin to exclude it —
  record the gap and flag it to the owner.
- Reviewing uncommitted work → gone. The finder only ever sees a
  materialized committed tree; commit first.
- Choosing a base ref → gone. Branch reviews resolve the base themselves
  (open PR via `gh`, else `origin/<default>` with a `base-fallback` gap); PR
  targets always use the PR's real base from GitHub metadata, which also
  covers stacked PRs.

## Carried-over lessons

- In zsh, capture the review process result as `rc=$?`; `status` is
  read-only and can make a valid review wrapper fail before it records the
  report.
- Never use `pkill -f` with a pattern that matches the command line running
  `pkill` itself.
- A GitHub API/network fault (e.g. an `api.github.com` i/o timeout) is not a
  harness or PR problem: probe connectivity, wait, retry once; do not burn
  re-runs on it.
- Never close, retire, or replace a pane while its `pi-review` process is
  running — the run holds `review.lock` and interrupting it ends the round
  `incomplete`.
- The pinned CLI has no `--repo` flag; the repository is inferred from the
  cwd's git remote — run from a checkout of the target repo, never from an
  author worktree with mixed state.
