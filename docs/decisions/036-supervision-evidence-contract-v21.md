# ADR-036: Supervision evidence contract V2.1 — structured evidence, attention policy, deterministic outcomes

## Status

Accepted (owner-authored contract, 2026-09-19). Implementation sequenced after the C1 reducer move (file-collision avoidance) and the router promotion (landed). V2.2 elements are explicitly conditional on observed unknown-rates.

## Date

2026-09-19

## Context

The ADR-034 V2 supervision reviewer judges from a state whose primary evidence is `transcriptDelta` — a line-bounded projection of tmux pane output. Owner review found this under-feeds the judgment: the pane is an accidental visual projection of execution, not its record. Observed consequences this session: healthy quiet-work children (max-thinking planner, verification runs, conflict resolution) produced four consecutive `unknown` attention wakes with flat signal distributions and `verification_passed` reasons that the reviewer had no basis to interpret; and the only evidence for `meaningful advancement` was narration, which a child can state falsely.

Separately, the E4 nit (line-bounded but not byte-bounded state) and the transcript exposure surface (a child printing a secret flows it to the reviewer request) are structural, not incidental.

Owner-authored replacement contract, informed by scout reports: VCC (lllyasviel/VCC, Apache-2.0) proves deterministic agent-trace compilation with byte-identical invariants; `@adamjen/pi-vcc` compiles Pi session JSONL deterministically (35–99% reduction, pointer recall, no LLM); dsh-compaction-instant shows the pattern ported across harnesses; Devin persists structured session data locally (scout-verified FEASIBLE — session records with tool calls, observations, metrics keyed by session id).

## Decision

**Evidence hierarchy (epistemic order):** assignment (what is supposed to happen) → structured trace (what the agent actually did) → workspace state (what artifacts actually changed) → terminal transcript (what the agent says about it, SUPPLEMENTAL). Jev answers on the convergence of these; no single source is primary.

**V2.1 scope (this implementation):**
- Per-runner trace source: Pi children expose session JSONL paths in their agent records (consumed directly); Devin children expose structured session records (scout-verified: tool calls with outcomes, observations, metrics — reader adapter required); runners without structured traces fall back to bounded terminal lines (`source: "tmux-fallback"` is part of the state).
- Workspace view per cadence: `baseRevision`, `headRevision`, `dirty`, `changedFiles` (path/status/added/deleted), diff stats, `fingerprint` — no full diff. Bounded recent hunks and files-written-since-last-review are V2.2.
- Deterministic `executionDigest`: actions compacted by class (read/search/edit/command with exit code and duration), never LLM-summarized. The evidence chain `edit → failing test → edit → passing test` must survive compaction (non-zero exits, errors, writes, first/last occurrences are never compacted away).
- Byte budgets with truncation priority: assignment 8KB (never truncated), trace 32KB, patch 16KB (V2.2), terminal 8KB (sacrificed first), total state 64KB. Over-budget structural evidence → `reviewer_unavailable`, never silent truncation of causal events.
- Outbound safety: build → deterministic compaction → byte bounding → local sensitive-context scan → only `safe` sends. `sensitive|indeterminate` → no request, `reviewer_unavailable`. No semantic redaction (it silently alters evidence).
- **Attention policy separated from classification** (code, not Jev): `risk`/`blocked`/`appears_complete`/`stalled` → wake; `progress` → silent; `unknown` → silent during **baseline grace** (first review of a reservation with `workingForMs ≤ 2×cadence`), wake otherwise. Baseline acquisitions are expected states, not findings.
- **Reducer amendment (supersedes ADR-034's gate-first ordering for interrupts):** `risk` and `blocked` are interrupt signals evaluated BEFORE the evidence gate — they wake a human, so a miss is more expensive than a false wake; the evidence gate still governs `appears_complete`/`stalled`/`progress`/fallthrough. `stalled` on a first observation requires ≥ 0.85 (no trajectory exists to ground a lower bar).
- **Deterministic summary:** Jev never generates prose. The summary is code-composed (`classification: signals; trace=cursor; workspace=fingerprint`) — auditable, aggregatable, and the judgment-of-judgment anti-pattern stays dead.
- **Version identity:** reviewer contract version, pinned Jev model, question-set hash, reducer version, thresholds, compiler name/version/config hash, state-builder hash — a change to any is config drift and invalidates threshold calibration, surfaced not silent.
- **Reviewer failure semantics:** timeout/429/5xx/malformed/sensitive/oversized → `{classification: unknown, attention: none, reason: reviewer_unavailable}` — infrastructure failure is not evidence about the child; retry next cadence; no manager wake for TypeSafe downtime.

**V2.2 scope (gated on observed unknown-rates after V2.1):** VCC-style `SupervisionView` port (IR → the five event classes, plus the two scout-identified port additions: a semantic action classifier distinguishing mutation/execution/read tools, and explicit outcome pairing SUCCESS/FAILURE/EXIT_CODE per call), trace cursors in `previousReview` (compile JSONL `from..to` per cadence), bounded hunks for files written since the previous review. The probe evidence: VCC's IR already maps to the five classes; the port additions are exactly the gap between generic compilation and supervision-grade evidence.

**Feasibility (scout-verified this session):** Pi children — session JSONL paths present in agent records. Devin children — structured session storage exists locally, parseable, keyed by the session id Herdr already tracks (reader adapter required; herdr itself does not proxy it). AGY — tmux-fallback until its own trace surface is mapped. `@adamjen/pi-vcc` is Apache-2.0 and reusable for Pi children with the two port additions; VCC upstream is Apache-2.0.

## Alternatives considered

### LLM summarization of the trace before Jev

Rejected: the reviewer would judge another model's judgment — the semantic-inference chain the whole program exists to remove. Deterministic compilation preserves the evidence; Jev does the only semantic step.

### Semantic redaction of sensitive content before sending

Rejected for V2.1: redaction alters evidence semantics invisibly. Fail closed (no request) instead; the child's pane printing secrets is a child-discipline problem the baseline already covers.

### Full diff every cadence

Rejected: large irrelevant state is the documented Jev weakness; per-cadence delta (files written since previous review, bounded hunks) observes the work's delta, not the PR's entirety.

### Keeping the ADR-034 gate-first reducer for interrupts

Rejected by the owner: `risk`/`blocked` wake a human — the asymmetry that justifies interrupt-before-gate. The evidence gate continues to govern every non-interrupt classification. First-observation `stalled` additionally requires ≥ 0.85.

## Consequences

- Implementation is a node family (the evidence pipeline: per-runner trace adapters, digest/workspace builders, sensitive scan, attention policy, deterministic summary) sequenced after C1 (the reducer move owns `src/reviewer.ts`) and independent of the B-family launch-schema work except `src/supervision/reviewer.ts` state construction, which the family owns.
- The tuning dataset (ADR-034's D-family) gains provenance fields (trace cursor, workspace fingerprint) — every wake becomes reconstructible to the exact evidence that produced it.
- The 100-line transcript cap is retired in favor of byte budgets with declared truncation priority; E4 is absorbed by this ADR.
- Unknown wakes during baseline grace disappear; wakes that remain are grounded by digest + structured evidence + trajectory.

## V2 signal questions (verbatim wordings and truth criteria)

Six independent nouls in one `systemOne` call. Wording is contract — workers do not paraphrase.

- `evidence_sufficient` — "Is the supplied evidence sufficient to make a meaningful judgment about the child's current execution state?" TRUE: the trace, workspace state, terminal evidence, or previous observation provides concrete evidence about what the agent is doing or has changed. FALSE: the evidence is absent, purely incidental, too ambiguous, or insufficient to distinguish meaningful execution states.
- `progress` — "Does the supplied evidence show meaningful advancement toward the assignment since the previous observation, or within this observation when no previous observation exists?" TRUE includes: relevant implementation changed; new useful evidence established; a previously failing check now passes; a new milestone reached; a meaningful hypothesis tested; failure advanced toward resolution. FALSE excludes mere activity: re-reading, repeated commands, cosmetic churn, progress bars, unchanged failures.
- `stalled` — "Does the evidence show repeated activity without meaningful advancement?" TRUE: repeated same approach; oscillation; same failure with no new evidence; no relevant artifact change across observations. Mere absence of output is NOT sufficient.
- `blocked` — "Does the evidence show the child is waiting on a dependency, permission, information, resource, or action it cannot resolve itself?" A normal code error is not a blocker.
- `risk` — "Does the evidence show the child taking or preparing an incorrect, destructive, unauthorized, or assignment-violating action?" Includes `constraints` violations.
- `appears_complete` — "Does the evidence establish the assignment's doneWhen conditions sufficiently to make the child appear finished despite no terminal lifecycle state?" `progressMarkers` never count as completion criteria.

## Tier-0 deterministic violations (code-owned, outside Jev)

Several checks leave Jev's jurisdiction entirely — code raises them directly as attention, no probabilistic judgment:

- read-only assignment + dirty workspace
- forbidden tool used
- budget exceeded
- process crashed

Evidence hierarchy: Tier 0 deterministic violations (code) → Tier 1 structured activity (JSONL events, git/worktree state, test results, file changes) → Tier 2 narrative evidence (terminal transcript) → Tier 3 semantic interpretation (Jev). Jev observes the convergence of Tiers 1–2 and answers probabilities; code owns Tier 0 and every deterministic decision.

## Assignment digest fields

`assignment: { objective, doneWhen (terminal criteria only), progressMarkers (intermediate observable states — never count as completion criteria), constraints }`. `progressMarkers` give the first review verifiable advancement targets (the grounding the N8 first-cadence 0.58 lacked).

## V2 result shape

```ts
type SupervisionReviewResultV2 = {
  schemaVersion: 2;
  classification: "progress" | "stalled" | "blocked" | "risk" | "appears_complete" | "unknown";
  signals: SupervisionSignals;
  attention: "none" | "wake_manager";
  reason: "classified" | "baseline" | "insufficient_evidence" | "signal_conflict" | "reviewer_unavailable";
  lastMeaningfulProgressAtMs: number | null;
  evidence: { traceFromCursor: string | null; traceToCursor: string | null; traceDigestHash: string; workspaceFingerprint: string | null };
  summary: string; // deterministic, code-composed — Jev never generates text
};
```

The public contract `{classification, summary}` is unchanged for consumers; the V2 shape is internal to the reviewer module.

## VCC SupervisionView (V2.2, gated)

The trace is a deterministic VCC-style projection of the authoritative runner JSONL — never a model summary. Contract: `trace: { compiler: "vcc-supervision", compilerVersion, contractVersion: 1, source: "runner-jsonl" | "tmux-fallback", fromCursor, toCursor, lines: [{ref, text}] (ref = recoverable pointer into the raw JSONL), rawEventCount, truncated, digestHash }`. Invariant: same JSONL range + same compiler version → byte-identical view. Never compacted away: non-zero command exit, exception/error, permission/auth failure, tool refusal, file write/edit, git mutation, process termination, explicit blocker, explicit completion claim, first and last occurrence of any event pattern.

Deterministically dropped: progress bars, spinner updates, repeated identical tool output, harness XML, system-reminders, ANSI, token/accounting events, queue operations, duplicate streamed fragments.

The auditability payoff: `risk = .81; evidence refs #188–#193` reconstructs to the exact raw JSONL entries without trusting any generated summary. The anti-pattern this kills: Jev judging another model's paraphrase.

## Measurement plan (A/B/C before V2.2 adoption)

A = tmux 100 lines (current), B = raw JSONL bounded, C = VCC SupervisionView. Metrics: evidence-sufficient rate, progress/stall/block/risk accuracy, tokens, payload bytes, false-positive wakeups, missed wakeups. V2.2 proceeds only if C beats A/B on the accuracy metrics at acceptable payload cost.

## Scout findings annex (2026-09-19, consolidated before pane loss)

**Devin trace feasibility (scout-devin-trace):** FEASIBLE. Devin persists structured session records locally (JSON: tool calls with `source_call_id`, observations with per-call results, file paths, token metrics). Herdr tracks Devin children by session id (`agent_session.kind = "id"`) but does not proxy session data; `herdr agent read` is terminal-only; the socket API exposes no transcript stream. Runner-JSONL evidence for Devin children requires a reader adapter over Devin's own storage — no herdr-side change.

**VCC architecture (scout-vcc-arch):** Apache-2.0. Pipeline: lexer → parser → canonical IR → lowering targets (Full/UI/Adaptive), byte-identical for identical input. AppWorld experiment: switching ONLY the trace representation (raw JSONL → VCC views) improved pass rate in all three model configurations and cut reflector token consumption by one-half to two-thirds (preprint, author-acknowledged as not yet peer-reviewed). The SupervisionView port maps IR node types to the five event classes (narration = assistant nodes; file writes = write/edit tool nodes paired with tool_result confirmations; command failures/successes = tool_error/tool_result with exit codes; completion/block/help = user/assistant stopping conditions) and must ADD: (1) a semantic action classifier distinguishing mutating tools (Write/Edit) and process execution (Bash) from passive reads (Read/Glob/Grep) — VCC treats all tools uniformly; (2) explicit outcome pairing (SUCCESS/FAILURE/EXIT_CODE per call, highlighting test failures and stderr) — VCC collapses outcomes into raw line references.

**pi-vcc reusability (scout-pivcc-port):** `@adamjen/pi-vcc` consumes Pi session JSONL directly, produces deterministic sections (chronological transcript, collapsed one-liner tools, goal, files & changes, commits, outstanding context) with pointer recall into raw entries; reported reductions 35–99% (>96% on large sessions); no LLM in the loop. Reusable by Herdr for Pi children as a library; the SupervisionView lowering still needs the two port additions above. dsh-compaction-instant (DeepSeek harness) confirms the pattern ports across harnesses: LLM-free, pointer-based recovery.
