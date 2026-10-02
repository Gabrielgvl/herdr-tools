/**
 * The shared Tools-owned managed-run completion gate (ADR-031, N2).
 *
 * One gate per host binds each allocated handoff run to the exact launched
 * identity — terminal, agent name/kind, and native session; the pane id is
 * tracked but excluded from matching because a supervised pane can move — and
 * every current-cycle artifact acceptance, repair fence, and runtime-authored
 * outcome flows through it under the run's sidecar flock. Waits, supervision,
 * jobs, and inspection all consult the same bound runs, so a managed run's
 * completion is never read off raw `agent_status` alone.
 *
 * Semantics the gate enforces:
 * - `completed` raw observations (`idle`/`done`) match only once a current
 *   artifact validates; `terminal` additionally requires the artifact status
 *   to correspond to the observed terminal state (`blocked` ↔ `blocked`;
 *   `idle`/`done` ↔ `done`/`cancelled`/`failed`).
 * - An artifact is consumed once: while a new work cycle is open, re-presented
 *   content identical to the accepted digest is `stale`, never re-accepted.
 * - Repair prompts are fenced per artifact version: the attempt and fence are
 *   persisted before any prompt is sent, and a version already fenced is never
 *   re-prompted.
 * - `cancelled`/`failed` are runtime-authored only; `recovery_pending` marks
 *   durable state a dead host left unresolved.
 */

import { randomUUID } from "node:crypto";
import {
  HandoffError,
  readHandoffArtifact,
  readHandoffState,
  updateHandoffState,
  type HandoffAllocation,
  type HandoffLifecycleState,
  type HandoffState,
  type HandoffStatus,
  type HandoffTraceHistory,
  type HandoffWorkspaceRecord
} from "./handoff.js";

/** The exact launched identity a run binds to; pane id may change on moves. */
export interface HandoffBoundIdentity {
  paneId: string;
  terminalId: string;
  agentName: string;
  agentKind: string;
  agentSession: { source: string; agent: string; kind: string; value: string };
  agentId?: string | null;
}

export type HandoffValidationState = "accepted" | "missing" | "invalid" | "untrusted" | "oversized" | "stale" | "unavailable";

/** The per-read verdict of the current-cycle artifact check. */
export interface HandoffValidation {
  state: HandoffValidationState;
  /** The parser's refusal reason for `invalid`, when one was recorded. */
  reason?: string;
  artifact?: { status: HandoffStatus; sha256: string; bytes: number; version: number };
}

/** Runtime-authored terminal marks; `handed_off` is the agent-authored record. */
export type HandoffOutcome = Exclude<HandoffLifecycleState, "awaiting_handoff">;
/** Cycle marks persisted on `lifecycle.detail` without changing the lifecycle state. */
export type HandoffCycleMark = "provider_limit" | "cycle_reopened";
export const HANDOFF_CYCLE_MARKS: ReadonlySet<string> = new Set<HandoffCycleMark>(["provider_limit", "cycle_reopened"]);

/** The bounded projection surfaced through waits, jobs, and inspection. */
export interface HandoffRunEvidence {
  runId: string;
  path: string;
  state: HandoffLifecycleState;
  /** The latest current-cycle artifact verdict this host computed, when one ran. */
  validation?: { state: HandoffValidationState; reason?: string };
  artifact?: { status?: HandoffStatus; version: number; sha256: string; bytes: number };
  /** Bounded non-secret repair metadata: counts and the fenced version, never the token. */
  repair?: { attempts: number; fenceVersion?: number };
}

/** Why a surface reports no bound-run evidence instead of the projection. */
export type HandoffUngatedReason = "identity_unavailable" | "identity_changed" | "no_managed_run" | "gate_unavailable";

/** The inspect/jobs handoff block: bound-run evidence, or an explicit reason it is ungated. */
export type HandoffInspection =
  | ({ gated: true } & HandoffRunEvidence)
  | { gated: false; reason: HandoffUngatedReason };

/**
 * The shared bounded evidence projection: exact identity → bound run →
 * evidence. When identity is absent the caller supplies the reason the records
 * could not prove the current occupant, so every surface says why it is
 * ungated rather than omitting the block. Never carries artifact bodies or
 * fence tokens.
 */
export function projectHandoffEvidence(
  gate: HandoffGate | undefined,
  identity: Pick<HandoffBoundIdentity, "terminalId" | "agentName" | "agentKind" | "agentSession"> | undefined,
  absentReason: HandoffUngatedReason = "identity_unavailable"
): HandoffInspection {
  if (gate === undefined) return { gated: false, reason: "gate_unavailable" };
  if (identity === undefined) return { gated: false, reason: absentReason };
  const run = gate.lookup(identity);
  if (run === undefined) return { gated: false, reason: "no_managed_run" };
  return { gated: true, ...gate.evidence(run) };
}

/** One bound run: the allocation plus this host's view of the sidecar. */
export interface HandoffRun {
  readonly allocation: HandoffAllocation;
  readonly runId: string;
  readonly artifactPath: string;
  /** Current bound identity; `paneId` is refreshed by `notePane` on moves. */
  identity: HandoffBoundIdentity;
  /** A work cycle begun after the last accepted artifact is still open. */
  cycleOpen: boolean;
  /** Last accepted artifact, mirrored from the committed sidecar. */
  accepted: { sha256: string; bytes: number; version: number; status?: HandoffStatus } | null;
  /** Latest committed lifecycle state this host observed. */
  lifecycle: HandoffLifecycleState;
  /** The latest verdict `validate` computed for this run, projected by `evidence`. */
  lastValidation?: { state: HandoffValidationState; reason?: string };
  repair: { attempts: number; fenceVersion: number | null };
}

/**
 * Repair prompts are bounded twice: at most one fence per artifact version
 * ("re-prompt once for the same artifact version") and a hard cap on total
 * attempts so a child that keeps writing invalid artifacts cannot be prompted
 * forever.
 */
export const HANDOFF_MAX_REPAIR_ATTEMPTS = 8;

function identityKey(identity: Pick<HandoffBoundIdentity, "terminalId" | "agentName" | "agentKind" | "agentSession">): string {
  const session = identity.agentSession;
  return [identity.terminalId, identity.agentName, identity.agentKind, session.source, session.agent, session.kind, session.value].join("\0");
}

function validationFailure(error: HandoffError): HandoffValidation["state"] {
  switch (error.code) {
    case "HANDOFF_ARTIFACT_MISSING": return "missing";
    case "HANDOFF_ARTIFACT_INVALID": return "invalid";
    case "HANDOFF_ARTIFACT_OVERSIZED": return "oversized";
    case "HANDOFF_ARTIFACT_UNTRUSTED": return "untrusted";
    default: return "unavailable";
  }
}

/** Retain the verdict so the bounded projection can show it after the fact. */
function remembered(run: HandoffRun, validation: HandoffValidation): HandoffValidation {
  run.lastValidation = { state: validation.state, ...(validation.reason === undefined ? {} : { reason: validation.reason }) };
  return validation;
}

function mirror(run: HandoffRun, state: HandoffState): void {
  run.accepted = state.artifact.sha256 === null
    ? null
    : {
        sha256: state.artifact.sha256,
        bytes: state.artifact.bytes ?? 0,
        version: state.artifact.version,
        ...(state.artifact.status === undefined ? {} : { status: state.artifact.status })
      };
  run.lifecycle = state.lifecycle.state;
  run.repair = { attempts: state.repair.attempts, fenceVersion: state.repair.fence?.version ?? null };
}

/**
 * Decide whether a gated wait condition is satisfied for a managed target.
 * The raw status still applies: the gate only ever narrows, it never widens —
 * an accepted artifact cannot make a `working` run look completed.
 */
export function handoffGateMatches(validation: HandoffValidation, until: "completed" | "terminal", rawStatus: string): boolean {
  if (until === "completed") {
    return (rawStatus === "idle" || rawStatus === "done") && validation.state === "accepted";
  }
  if (rawStatus !== "idle" && rawStatus !== "done" && rawStatus !== "blocked") return false;
  if (validation.state !== "accepted" || validation.artifact === undefined) return false;
  if (rawStatus === "blocked") return validation.artifact.status === "blocked";
  return validation.artifact.status !== "blocked";
}

export interface HandoffGate {
  /**
   * Bind an allocated run to the exact launched identity. The child and
   * native-session fields are persisted under the flock before the run becomes
   * visible to `lookup`, so no acceptance can precede the identity binding.
   */
  bind(allocation: HandoffAllocation, identity: HandoffBoundIdentity, watermark?: { stateChangeSeq: number; revision: number }): Promise<HandoffRun>;
  /** The run bound to this exact move-stable identity, if this host owns one. */
  lookup(identity: Pick<HandoffBoundIdentity, "terminalId" | "agentName" | "agentKind" | "agentSession">): HandoffRun | undefined;
  /** Forget the run after its supervisor settles; the sidecar remains durable. */
  drop(run: HandoffRun): void;
  /** Mark the run's current pane after a supervised move. In-memory only. */
  notePane(run: HandoffRun, paneId: string): void;
  /** A `working` transition opened a new cycle after the last acceptance. */
  beginCycle(run: HandoffRun): void;
  /** Validate the current artifact and, when new, accept it under the flock. */
  validate(run: HandoffRun): Promise<HandoffValidation>;
  /**
   * Fence one repair prompt for the current artifact version. The attempt and
   * fence are persisted before this returns a token; `null` means this version
   * is already fenced or the attempt bound is spent — the caller must not send.
   */
  beginRepair(run: HandoffRun): Promise<{ version: number; token: string } | null>;
  /**
   * Persist a terminal outcome (`handed_off`/`cancelled`/`failed`/`recovery_pending`)
   * with its detail; a prior detail never outlives the outcome it described.
   */
  recordOutcome(run: HandoffRun, outcome: HandoffOutcome, detail?: string): Promise<void>;
  /**
   * Persist a cycle mark on the run without changing its lifecycle state: a
   * typed provider limit, or a follow-up cycle reopened after `handed_off`.
   * Lane retirement refuses a marked run until a fresh outcome replaces it.
   */
  markCycle(run: HandoffRun, mark: HandoffCycleMark): Promise<void>;
  /** The bounded evidence projection for jobs and inspection. */
  evidence(run: HandoffRun): HandoffRunEvidence;
  /** Mark every still-unresolved run `recovery_pending`; best effort at teardown. */
  shutdown(): Promise<void>;
}

/**
 * The ADR-040 amendment seam: capture where the child's native trace ends
 * when a new artifact content is first validated. The gate awaits it before
 * the acceptance mutation and persists it beside `artifact.mtimeMs`; a
 * capture that throws or returns `undefined` persists the anchor without a
 * fingerprint (the retire check then refuses `trace_history_missing`) and is
 * journaled once per run.
 */
export type HandoffTraceHistoryCapture = (
  identity: HandoffBoundIdentity,
  workspace: HandoffWorkspaceRecord | undefined,
  signal: AbortSignal,
) => Promise<HandoffTraceHistory | undefined>;

export interface HandoffGateDeps {
  traceHistory?: HandoffTraceHistoryCapture;
  /** Bounded structured journal sink; `key=value` records, never content. */
  log?: (line: string) => void;
}

const BOUNDED_REASON = /^[\w.:-]{1,64}$/u;

export function createHandoffGate(deps: HandoffGateDeps = {}): HandoffGate {
  const runs = new Map<string, HandoffRun>();
  const log = deps.log ?? (() => undefined);
  /** Runs whose history capture already failed once — one journal line, not one per validate. */
  const captureFailed = new Set<string>();
  const signal = new AbortController().signal;

  async function captureHistory(run: HandoffRun): Promise<HandoffTraceHistory | undefined> {
    if (deps.traceHistory === undefined) return undefined;
    let history: HandoffTraceHistory | undefined;
    let reason = "capture_undefined";
    try {
      const current = await readHandoffState(run.allocation);
      history = await deps.traceHistory(run.identity, current.child.workspace, signal);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      reason = typeof code === "string" && BOUNDED_REASON.test(code) ? `capture_threw:${code}` : "capture_threw";
    }
    if (history === undefined && !captureFailed.has(run.runId)) {
      captureFailed.add(run.runId);
      log(`herdr-tools handoff_trace_history run=${run.runId} decision=capture_failed reason=${reason}`);
    }
    return history;
  }

  async function recordOutcome(run: HandoffRun, outcome: HandoffOutcome, detail?: string): Promise<void> {
    const state = await updateHandoffState(run.allocation, (current) => {
      current.lifecycle.state = outcome;
      if (detail === undefined) delete current.lifecycle.detail;
      else current.lifecycle.detail = detail.slice(0, 256);
    });
    mirror(run, state);
  }

  async function markCycle(run: HandoffRun, mark: HandoffCycleMark): Promise<void> {
    const state = await updateHandoffState(run.allocation, (current) => {
      current.lifecycle.detail = mark;
    });
    mirror(run, state);
  }

  return {
    async bind(allocation, identity, watermark) {
      const state = await updateHandoffState(allocation, (current) => {
        current.child.paneId = identity.paneId;
        current.child.terminalId = identity.terminalId;
        current.child.agentId = identity.agentId ?? null;
        current.nativeSession = { ...identity.agentSession };
        if (watermark !== undefined) current.lifecycle.watermark = { ...watermark };
      });
      const run: HandoffRun = {
        allocation,
        runId: allocation.runId,
        artifactPath: allocation.artifactPath,
        identity: { ...identity, agentSession: { ...identity.agentSession } },
        // A reattached run whose artifact was already accepted must not have
        // that acceptance opened into staleness — the sidecar decides whether
        // a cycle is outstanding; a fresh launch always starts one.
        cycleOpen: state.artifact.sha256 === null,
        accepted: null,
        lifecycle: "awaiting_handoff",
        repair: { attempts: 0, fenceVersion: null }
      };
      mirror(run, state);
      runs.set(identityKey(identity), run);
      return run;
    },

    lookup(identity) {
      return runs.get(identityKey(identity));
    },

    drop(run) {
      const key = identityKey(run.identity);
      if (runs.get(key) === run) runs.delete(key);
    },

    notePane(run, paneId) {
      run.identity = { ...run.identity, paneId };
    },

    beginCycle(run) {
      run.cycleOpen = true;
    },

    async validate(run) {
      let artifact;
      try {
        artifact = await readHandoffArtifact(run.allocation);
      } catch (error) {
        if (error instanceof HandoffError) {
          const reason = error.details.reason;
          return remembered(run, {
            state: validationFailure(error),
            ...(typeof reason === "string" ? { reason: reason.slice(0, 64) } : {})
          });
        }
        throw error;
      }
      // ADR-040 amendment: the native-history fingerprint is captured before
      // the mutation (the mutator is synchronous) and only when this content
      // looks new — a byte-identical re-presentation never re-captures.
      const history = run.accepted?.sha256 === artifact.sha256 ? undefined : await captureHistory(run);
      let stale = false;
      let state;
      try {
        state = await updateHandoffState(run.allocation, (current) => {
          if (current.artifact.sha256 === artifact.sha256) {
            // Content identical to the last acceptance: still current while no
            // new cycle is open, stale once the child has worked again. The
            // anchor stays at the time this content was FIRST observed.
            stale = run.cycleOpen;
            return;
          }
          current.artifact.sha256 = artifact.sha256;
          current.artifact.bytes = artifact.bytes;
          current.artifact.version += 1;
          current.artifact.status = artifact.status;
          // The retirement anchor: the write time first observed for this content.
          current.artifact.mtimeMs = artifact.mtimeMs;
          if (history === undefined) delete current.artifact.traceHistory;
          else current.artifact.traceHistory = history;
        });
      } catch (error) {
        if (error instanceof HandoffError) return remembered(run, { state: "unavailable" });
        throw error;
      }
      mirror(run, state);
      if (stale) return remembered(run, { state: "stale" });
      run.cycleOpen = false;
      return remembered(run, {
        state: "accepted",
        artifact: { status: artifact.status, sha256: artifact.sha256, bytes: artifact.bytes, version: state.artifact.version }
      });
    },

    async beginRepair(run) {
      let fence: { version: number; token: string } | null = null;
      const state = await updateHandoffState(run.allocation, (current) => {
        if (current.repair.attempts >= HANDOFF_MAX_REPAIR_ATTEMPTS) return;
        if (current.repair.fence !== null && current.repair.fence.version === current.artifact.version) return;
        fence = { version: current.artifact.version, token: randomUUID() };
        current.repair.attempts += 1;
        current.repair.fence = fence;
      });
      mirror(run, state);
      return fence;
    },

    recordOutcome,
    markCycle,

    evidence(run) {
      return {
        runId: run.runId,
        path: run.artifactPath,
        state: run.lifecycle,
        ...(run.lastValidation === undefined ? {} : { validation: run.lastValidation }),
        ...(run.accepted === null ? {} : {
          artifact: {
            ...(run.accepted.status === undefined ? {} : { status: run.accepted.status }),
            version: run.accepted.version,
            sha256: run.accepted.sha256,
            bytes: run.accepted.bytes
          }
        }),
        ...(run.repair.attempts === 0 ? {} : {
          repair: {
            attempts: run.repair.attempts,
            ...(run.repair.fenceVersion === null ? {} : { fenceVersion: run.repair.fenceVersion })
          }
        })
      };
    },

    async shutdown() {
      // A dead host fabricates nothing: unresolved runs are marked
      // recovery_pending so a later recovery node can see them, and a failed
      // write can never block teardown.
      await Promise.all([...runs.values()]
        .filter((run) => run.lifecycle === "awaiting_handoff")
        .map((run) => recordOutcome(run, "recovery_pending", "manager_session_shutdown").catch(() => undefined)));
    }
  };
}
