/**
 * The ADR-040 lane-retirement sweep (design B3): a daemon-owned periodic pass
 * that closes a finished lane's pane once the full proof chain holds — never
 * on the sidecar's `handed_off` lifecycle alone.
 *
 * One sweep takes exactly one authoritative `api snapshot`, enumerates the
 * endpoint's run sidecars, and for every `handed_off` run proves, in order:
 *
 * 1. sidecar parses, `child.terminalId` and `nativeSession` bound;
 * 2. `classifyChild` exact match, pane `idle`/`done`, and the agent record's
 *    `state_change_seq` continuously unchanged for `graceMs` (in-memory
 *    `runId → {seq, since}` — a changed seq, an active status, or an absence
 *    resets the clock; restarts conservatively re-observe);
 * 3. pane tokens prove `identity_provenance=launched` and `identity_session`
 *    equals the recorded session — advisory evidence, secondary to the exact
 *    match, and fail-closed when missing, malformed, or contradictory;
 * 4. the pane is no manager: `classifyCaller` must yield a launched leaf, its
 *    session key must hold no open intent ledger and no nonterminal children,
 *    and its own mailbox `unread/` must be empty;
 * 5. owner topology: the current owner (provenance v2) resolved to a live pane
 *    by exact session — `state.manager.paneId` as the fallback — must not sit
 *    inside the close's cascade (`PROTECTED_RESOURCE` refuses,
 *    `TOPOLOGY_INVALID` defers);
 * 6. a `focused` pane defers, but only for a bounded number of sweeps
 *    (`maxFocusDefers`) — a stuck focus flag cannot park a finished lane;
 * 7. `retention: "keep"` (task field or pane token) marks the run `kept` and
 *    never retires; the kill switch turns an otherwise-eligible close into a
 *    journaled `would_retire` and a `disabled` view.
 *
 * The close itself runs under the pane write lock: `pane get`/`agent get`
 * re-prove identity, tokens, status, and focus; `selfClose.begin` correlates
 * the supervisor's own `pane_closed` wake; `closeWithReadback` proves the
 * pane absent. A failed close retries on later sweeps and stops at
 * `maxAttempts` with state `failed`. A proven close marks the run retired —
 * the `retiredByDaemon` marker `JobRegistry` consults before suppressing the
 * trailing `job_terminal` — and emits exactly one `lane_retired` event to the
 * run's current owner mailbox.
 */

import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { tokenValue } from "../agent-identity.js";
import { classifyCaller, mergedToken } from "../caller-policy.js";
import { paneCloseTopology, topologySummary, validateClose, type CloseTopology } from "../close.js";
import {
  currentHandoffOwner,
  readHandoffProvenance,
  readHandoffState,
  RUN_ID_PATTERN,
  type HandoffAllocation,
  type HandoffAllocator,
  type HandoffLifecycleState,
  type HandoffNamespace,
  type HandoffProvenance,
  type HandoffState,
} from "../handoff.js";
import type { JobRegistry } from "../job-registry.js";
import { requirePromptTargetIdentity, type AgentSessionIdentity } from "../messages/prompt.js";
import { agentFrom, findSessionPane, paneFrom, snapshotIdentityRecords } from "../messages/prompt-target.js";
import { closeWithReadback, type CloseReadbackCli } from "../mutations.js";
import type { PaneWriteGuard, PaneWriteLease } from "../pane-write-lock.js";
import type { SupervisedIdentity } from "../supervision/identity.js";
import type { SelfCloseTracker } from "../supervision/self-close.js";
import type { HerdrSnapshot } from "../targets.js";
import { managerSessionKey, type IntentStore, type LaunchIntentRecord } from "./intents.js";
import type { Mailbox } from "./mailbox.js";
import { classifyChild } from "./reattach.js";

/** The `retire` projection `DaemonStatusRun` carries (durable-supervisor §7). */
export interface RetireView {
  state: "watching" | "eligible" | "deferred" | "refused" | "retired" | "failed" | "kept" | "disabled";
  reason?: string;
  stableForMs?: number;
  at?: string;
}

export interface LaneRetirer {
  /** One retirement pass: enumerate runs, prove, defer/refuse, or close. */
  sweep(): Promise<void>;
  /** The run's current retirement view, or `undefined` when the sweep is not tracking it. */
  view(runId: string): RetireView | undefined;
  /**
   * The `job_terminal` suppression marker: true only for runs whose pane this
   * retirer closed — a `handed_off` run closed by anything else still emits.
   */
  retiredByDaemon(runId: string): boolean;
}

export interface LaneRetirerDeps {
  /** The endpoint's handoff run namespace, enumerated directly each sweep. */
  runs: HandoffNamespace;
  allocator: HandoffAllocator;
  intents: IntentStore;
  /** `writeRunEvent` for `lane_retired`; `list` for the child-mailbox guard. */
  mailbox: Pick<Mailbox, "writeRunEvent" | "list">;
  /** `pane get`/`agent get` re-proofs and the readback-proven `pane close`. */
  cli: CloseReadbackCli;
  /** Shared with the supervision registry: this host's own-close ledger. */
  selfClose: SelfCloseTracker;
  /** Live-supervisor lookup for the `lane_retired` jobId. */
  jobs: Pick<JobRegistry, "activeSupervisorFor">;
  /** One fresh authoritative snapshot per sweep and per close readback. */
  snapshot(): Promise<HerdrSnapshot>;
  options: {
    /** The kill switch: false journals `would_retire` and closes nothing. */
    enabled: boolean;
    /** Continuous idle/done stability required before a close (default 15 min). */
    graceMs: number;
    /** The cross-process pane write flock every herdr-tools sender takes. */
    paneLock: PaneWriteGuard;
    /**
     * Bounded focused deferrals: an otherwise-eligible lane whose pane stays
     * `focused` defers at most this many sweeps, then retires anyway — a
     * stale focus flag cannot park a finished lane forever (default 60).
     */
    maxFocusDefers?: number;
    /** Total close attempts — the initial try plus its retries — before `failed` (default 3). */
    maxAttempts?: number;
  };
  now?: () => Date;
  /** Bounded structured journal sink; one line per decision change. */
  log?: (line: string) => void;
}

const DEFAULT_MAX_FOCUS_DEFERS = 60;
const DEFAULT_MAX_ATTEMPTS = 3;
const BOUNDED_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
/** Intent-child run lifecycles that mean the recorded child is finished. */
const TERMINAL_CHILD_LIFECYCLES = new Set<HandoffLifecycleState>(["handed_off", "cancelled", "failed"]);
/** Terminal views persist: a run stays retired/failed/kept once decided. */
const TERMINAL_VIEWS = new Set<RetireView["state"]>(["retired", "failed", "kept"]);

interface LaneEntry {
  /** The continuously observed `state_change_seq` — the stability clock's value. */
  seq?: number;
  /** `now()` when the current seq+status observation began; cleared on reset. */
  sinceMs?: number;
  /** Consecutive focused deferrals while otherwise eligible. */
  focusDefers: number;
  /** Close attempts spent — a lock or re-proof refusal never spends one. */
  attempts: number;
  view: RetireView;
  /** `<decision>:<reason>` last journaled — one line per change, not per sweep. */
  journaled?: string;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/** A bounded single-line reason fragment — journal text never carries free-form detail. */
function bounded(value: unknown): string {
  return (typeof value === "string" ? value : "unavailable").replace(/[^\x20-\x7e]/gu, "_").slice(0, 64);
}

function codeOf(error: unknown): string {
  const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && BOUNDED_CODE.test(code) ? code : "ERROR";
}

function sameSession(left: AgentSessionIdentity, right: AgentSessionIdentity): boolean {
  return left.source === right.source
    && left.agent === right.agent
    && left.kind === right.kind
    && left.value === right.value;
}

/** The agent record's `state_change_seq`, falling back to the pane record's. */
function observedSeq(records: readonly Record<string, unknown>[]): number | undefined {
  for (const candidate of records) {
    const seq = candidate.state_change_seq;
    if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) return seq;
  }
  return undefined;
}

export function createLaneRetirer(deps: LaneRetirerDeps): LaneRetirer {
  const now = () => (deps.now ?? (() => new Date()))();
  const log = deps.log ?? (() => undefined);
  const maxFocusDefers = deps.options.maxFocusDefers ?? DEFAULT_MAX_FOCUS_DEFERS;
  const maxAttempts = deps.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const ledger = new Map<string, LaneEntry>();
  /** Runs this daemon provably closed — the `job_terminal` suppression marker. */
  const retired = new Set<string>();

  /** One bounded journal line per decision change — never per sweep. */
  function journal(runId: string, entry: LaneEntry, decision?: string): void {
    const outcome = decision ?? entry.view.state;
    const key = `${outcome}:${entry.view.reason ?? "-"}`;
    if (entry.journaled === key) return;
    entry.journaled = key;
    log(`herdr-tools-daemon lane_retire run=${runId} decision=${outcome}${entry.view.reason === undefined ? "" : ` reason=${entry.view.reason}`}`);
  }

  function setView(runId: string, entry: LaneEntry, state: RetireView["state"], reason?: string, stableForMs?: number, decision?: string): void {
    entry.view = {
      state,
      ...(reason === undefined ? {} : { reason }),
      ...(stableForMs === undefined ? {} : { stableForMs }),
      at: now().toISOString(),
    };
    journal(runId, entry, decision);
  }

  function resetClock(entry: LaneEntry): void {
    entry.seq = undefined;
    entry.sinceMs = undefined;
  }

  /**
   * A sub-manager protection check: `undefined` only when every intent under
   * the candidate's own session key is closed and every recorded child run is
   * in a terminal lifecycle. Anything open or unproven refuses.
   */
  async function managedChildrenReason(intents: LaunchIntentRecord[]): Promise<string | undefined> {
    for (const intent of intents) {
      if (intent.state === "unresolved" || intent.state === "effecting") return "child_intent_open";
      for (const child of intent.children) {
        if (child.runId === undefined) continue;
        let lifecycle: HandoffLifecycleState;
        try {
          lifecycle = (await readHandoffState(await deps.allocator.open(child.runId))).lifecycle.state;
        } catch {
          return "child_intent_child_untrusted";
        }
        if (!TERMINAL_CHILD_LIFECYCLES.has(lifecycle)) return "child_manages_live_intent";
      }
    }
    return undefined;
  }

  /**
   * The under-lock re-proof: `pane get`/`agent get` records must still carry
   * the recorded identity, the launch tokens, an idle/done status, an
   * unchanged `state_change_seq`, and — while its defer bound holds — no
   * focused flag. Returns the bounded refusal reason, or `undefined` to close.
   */
  function recheck(records: Record<string, unknown>[], paneId: string, state: HandoffState, entry: LaneEntry): string | undefined {
    let live;
    try {
      live = requirePromptTargetIdentity(records, paneId);
    } catch {
      return "recheck_identity";
    }
    if (live.terminalId !== state.child.terminalId
      || live.agentName !== state.child.agentName
      || live.agentKind !== state.child.agentKind
      || !sameSession(live.agentSession, state.nativeSession!)) return "recheck_identity";
    const provenanceToken = mergedToken(records, "identity_provenance");
    if (provenanceToken.state !== "value" || provenanceToken.value !== "launched") return "recheck_tokens";
    const sessionToken = mergedToken(records, "identity_session");
    const expected = tokenValue(state.nativeSession!.value);
    if (sessionToken.state !== "value" || expected === undefined || sessionToken.value !== expected) return "recheck_tokens";
    const pane = records[0]!;
    const status = pane.agent_status;
    if (status !== "idle" && status !== "done") return "recheck_status";
    const seq = observedSeq(records);
    if (seq !== undefined && entry.seq !== seq) {
      // The lane worked between the sweep's observation and this lock — the
      // stability clock restarts; nothing about the pane is as observed.
      resetClock(entry);
      return "recheck_seq";
    }
    if (pane.focused === true && entry.focusDefers < maxFocusDefers) return "recheck_focused";
    return undefined;
  }

  async function closeLane(runId: string, run: HandoffAllocation, state: HandoffState, identity: SupervisedIdentity, entry: LaneEntry): Promise<void> {
    const paneId = identity.paneId;
    const signal = new AbortController().signal;
    let lease: PaneWriteLease;
    try {
      lease = await deps.options.paneLock.acquire(paneId);
    } catch {
      // Contention or an unavailable lock domain defers — it never spends an attempt.
      setView(runId, entry, "deferred", "pane_lock_unavailable");
      return;
    }
    try {
      const paneGet = await deps.cli.runJson(["pane", "get", paneId], signal);
      const agentGet = await deps.cli.runJson(["agent", "get", paneId], signal);
      // Pane record first, matching snapshotIdentityRecords' order — the
      // stability clock reads the same `state_change_seq` source both ways.
      const records = [paneFrom(paneGet.result, paneId), agentFrom(agentGet.result)];
      const refusal = recheck(records, paneId, state, entry);
      if (refusal !== undefined) {
        setView(runId, entry, "deferred", refusal);
        return;
      }
      const finish = deps.selfClose.begin(paneId);
      entry.attempts += 1;
      try {
        const closed = await closeWithReadback<HerdrSnapshot>({
          cli: deps.cli,
          argv: ["pane", "close", paneId],
          signal,
          targetId: paneId,
          readback: () => deps.snapshot(),
          targetPresent: (after) => after.panes.some((candidate) => candidate.pane_id === paneId),
          summarize: topologySummary,
        });
        // Only the close's own readback-proven success confirms the marker the
        // supervisor consults; an absent-without-mutation outcome reports
        // `retired` but lets the pane_closed wake land normally.
        finish(closed.reconciled === false);
      } catch (error) {
        finish(false);
        const code = `close_${codeOf(error)}`;
        if (entry.attempts >= maxAttempts) {
          setView(runId, entry, "failed", code);
        } else {
          setView(runId, entry, "deferred", code);
        }
        return;
      }
      retired.add(runId);
      setView(runId, entry, "retired", undefined, undefined, `retired pane=${paneId}`);
      // The live supervisor's jobId when one is still bound — the restart case
      // has none, and the event names the retirer itself.
      const jobId = deps.jobs.activeSupervisorFor(identity)?.jobId ?? "daemon-retire";
      try {
        const result = await deps.mailbox.writeRunEvent({
          kind: "lane_retired",
          runId,
          jobId,
          childIdentity: { agentName: identity.agentName, agentKind: identity.agentKind, paneId, terminalId: identity.terminalId },
          handoff: { state: "handed_off", ...(state.artifact.sha256 === null ? {} : { artifactSha256: state.artifact.sha256 }) },
          actions: [`pane_closed:${paneId}`, `artifact:${run.artifactPath}`],
        });
        if (!result.persisted) {
          log(`herdr-tools-daemon lane_retire run=${runId} decision=retired_event_unpersisted reason=${result.reason}`);
        }
      } catch {
        // The retirement already landed; a failed event write is journaled,
        // never claimed — the mailbox's own accounting records the loss.
        log(`herdr-tools-daemon lane_retire run=${runId} decision=retired_event_unpersisted reason=unavailable`);
      }
    } finally {
      await lease.release().catch(() => undefined);
    }
  }

  async function evaluate(runId: string, snapshot: HerdrSnapshot): Promise<void> {
    const prior = ledger.get(runId);
    if (prior !== undefined && TERMINAL_VIEWS.has(prior.view.state)) return;
    const entry = prior ?? { focusDefers: 0, attempts: 0, view: { state: "watching" as const } };

    let run: HandoffAllocation;
    let state: HandoffState;
    try {
      run = await deps.allocator.open(runId);
      state = await readHandoffState(run);
    } catch (error) {
      ledger.set(runId, entry);
      setView(runId, entry, "refused", `sidecar_${codeOf(error)}`);
      return;
    }
    if (state.lifecycle.state !== "handed_off") {
      ledger.delete(runId);
      return;
    }
    ledger.set(runId, entry);
    if (state.child.terminalId === null || state.nativeSession === null) {
      setView(runId, entry, "refused", "child_identity_unbound");
      return;
    }
    const childSession = state.nativeSession;

    let provenance: HandoffProvenance | undefined;
    try {
      provenance = await readHandoffProvenance(run);
    } catch {
      // A legacy or untrusted provenance still leaves the launch record's
      // manager pane as the topology fallback — it simply records no owner.
      provenance = undefined;
    }
    // The ADR-040 opt-out precedes live-identity work: a kept run never
    // retires, so nothing past this point is worth proving for it.
    if (provenance?.task.retention === "keep") {
      setView(runId, entry, "kept", "task_retention_keep");
      return;
    }
    // The child's own session key — the sub-manager and mailbox guards key on
    // it; a record whose session cannot form a key fails closed.
    let childKey: string;
    try {
      childKey = managerSessionKey(childSession);
    } catch {
      setView(runId, entry, "refused", "child_session_invalid");
      return;
    }

    const verdict = classifyChild(snapshot, state);
    if (verdict.kind === "absent") {
      ledger.delete(runId);
      log(`herdr-tools-daemon lane_retire run=${runId} decision=skipped reason=child_absent`);
      return;
    }
    if (verdict.kind === "ambiguous") {
      resetClock(entry);
      setView(runId, entry, "deferred", bounded(`child_${verdict.reason}`));
      return;
    }
    const identity = verdict.identity;
    const paneId = identity.paneId;
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId)!;
    const records = snapshotIdentityRecords(snapshot, paneId);

    const status = pane.agent_status;
    if (status !== "idle" && status !== "done") {
      resetClock(entry);
      setView(runId, entry, "deferred", `child_active:${bounded(status)}`);
      return;
    }
    const seq = observedSeq(records);
    if (seq === undefined) {
      resetClock(entry);
      setView(runId, entry, "deferred", "state_change_seq_unavailable");
      return;
    }
    const nowMs = now().getTime();
    if (entry.seq !== seq || entry.sinceMs === undefined) {
      entry.seq = seq;
      entry.sinceMs = nowMs;
    }
    const stableForMs = nowMs - entry.sinceMs;
    if (stableForMs < deps.options.graceMs) {
      setView(runId, entry, "watching", undefined, stableForMs);
      return;
    }

    const provenanceToken = mergedToken(records, "identity_provenance");
    if (provenanceToken.state !== "value" || provenanceToken.value !== "launched") {
      setView(runId, entry, "refused", `token_provenance_${provenanceToken.state === "value" ? "not_launched" : provenanceToken.state}`);
      return;
    }
    const sessionToken = mergedToken(records, "identity_session");
    if (sessionToken.state !== "value") {
      setView(runId, entry, "refused", `token_session_${sessionToken.state}`);
      return;
    }
    if (sessionToken.value !== tokenValue(childSession.value)) {
      setView(runId, entry, "refused", "token_session_mismatch");
      return;
    }
    // The cooperative no-contract opt-out (design B3 fallback): a `retention=keep`
    // pane token parks the lane exactly like the task field.
    const retentionToken = mergedToken(records, "retention");
    if (retentionToken.state === "value" && retentionToken.value === "keep") {
      setView(runId, entry, "kept", "token_retention_keep");
      return;
    }

    let policy;
    try {
      policy = classifyCaller(snapshot, paneId);
    } catch {
      setView(runId, entry, "refused", "caller_policy_unavailable");
      return;
    }
    if (policy.scope !== "worker") {
      setView(runId, entry, "refused", `child_is_manager:${policy.basis}`);
      return;
    }
    const managers = await deps.intents.listManagers().catch(() => undefined);
    if (managers === undefined) {
      setView(runId, entry, "deferred", "intents_unavailable");
      return;
    }
    if (managers.includes(childKey)) {
      const childIntents = await deps.intents.list(childKey).catch(() => undefined);
      if (childIntents === undefined) {
        setView(runId, entry, "deferred", "intents_unavailable");
        return;
      }
      const managed = await managedChildrenReason(childIntents);
      if (managed !== undefined) {
        setView(runId, entry, "refused", managed);
        return;
      }
    }
    const unread = await deps.mailbox.list(childKey).catch(() => undefined);
    if (unread === undefined) {
      setView(runId, entry, "deferred", "mailbox_unavailable");
      return;
    }
    if (unread.length > 0) {
      setView(runId, entry, "refused", "child_mailbox_unread");
      return;
    }

    // Owner topology: the v2 current owner's session resolved to a live pane,
    // else the launch record's manager pane — the cascade may never reach it.
    const owner = provenance === undefined ? null : currentHandoffOwner(provenance);
    const ownerPaneId = (owner === null ? undefined : findSessionPane(snapshot, owner)?.pane_id) ?? state.manager.paneId;
    const ownerRecord = snapshot.panes.find((candidate) => candidate.pane_id === ownerPaneId);
    const caller: CloseTopology["caller"] = {
      paneId: ownerPaneId,
      ...(ownerRecord?.tab_id === undefined ? {} : { tabId: ownerRecord.tab_id }),
      ...(ownerRecord?.workspace_id === undefined ? {} : { workspaceId: ownerRecord.workspace_id }),
    };
    const close = validateClose(paneCloseTopology(snapshot, caller), { kind: "pane", id: paneId, parentId: pane.tab_id });
    if (!close.allowed) {
      setView(runId, entry, close.code === "PROTECTED_RESOURCE" ? "refused" : "deferred", close.code === "PROTECTED_RESOURCE" ? "owner_topology_protected" : "topology_invalid");
      return;
    }

    if (pane.focused === true && entry.focusDefers < maxFocusDefers) {
      entry.focusDefers += 1;
      setView(runId, entry, "deferred", "focused", stableForMs);
      return;
    }
    // An exhausted bound keeps its count so the under-lock re-check does not
    // re-defer the same pane forever; only a genuinely unfocused sweep resets.
    if (pane.focused !== true) entry.focusDefers = 0;

    if (!deps.options.enabled) {
      setView(runId, entry, "disabled", undefined, stableForMs, "would_retire");
      return;
    }
    setView(runId, entry, "eligible", undefined, stableForMs);
    try {
      await closeLane(runId, run, state, identity, entry);
    } catch (error) {
      // A close-path fault the lease's finally already unwound — the run
      // keeps its spent attempts and retries on a later sweep.
      setView(runId, entry, "deferred", `sweep_error:${codeOf(error)}`);
    }
  }

  return {
    async sweep() {
      let snapshot: HerdrSnapshot;
      try {
        snapshot = await deps.snapshot();
      } catch (error) {
        // No observation, no proof: the sweep holds every clock and retries next tick.
        log(`herdr-tools-daemon lane_retire decision=sweep_unavailable reason=${bounded(codeOf(error))}`);
        return;
      }
      let entries: Dirent[];
      try {
        entries = await readdir(deps.runs.dir, { withFileTypes: true });
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          log(`herdr-tools-daemon lane_retire decision=sweep_unavailable reason=${bounded(codeOf(error))}`);
          return;
        }
        entries = [];
      }
      const seen = new Set<string>();
      for (const entry of entries) {
        if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
        seen.add(entry.name);
        try {
          await evaluate(entry.name, snapshot);
        } catch (error) {
          // Every fallible step inside evaluate() records its own deferral or
          // refusal before it can throw, so an escape here is a defect — not
          // a verdict. Journal it; the run retries with its last proven view.
          log(`herdr-tools-daemon lane_retire run=${entry.name} decision=sweep_error reason=${bounded(codeOf(error))}`);
        }
      }
      // A vanished run directory leaves nothing to project or retire.
      for (const runId of [...ledger.keys()]) {
        if (!seen.has(runId)) ledger.delete(runId);
      }
    },
    view(runId) {
      const entry = ledger.get(runId);
      return entry === undefined ? undefined : { ...entry.view };
    },
    retiredByDaemon(runId) {
      return retired.has(runId);
    },
  };
}
