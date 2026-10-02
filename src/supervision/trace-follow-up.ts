/**
 * The ADR-040 follow-up proof as one decision (amendment node E, §4.2): given
 * the run's sidecar, a fresh read of its artifact, and the bounded tail scan,
 * produce the retirement veto — or `undefined` when the lane is proven clear.
 * The lane retirer runs it in the sweep (after the child is proven present)
 * and again under the close lock with a `recheck_` prefix; every row of the
 * fail-closed table (§4.4) maps to exactly one reason here.
 *
 * The anchor passed to the scan is the **persisted** `artifact.mtimeMs`
 * (F13) — the fresh artifact serves content verification only, so a
 * byte-identical rewrite with a newer file mtime can never move the anchor
 * past a follow-up.
 */
import { HANDOFF_TRACE_KINDS, HandoffError, type HandoffArtifact, type HandoffState } from "../handoff.js";
import type { AgentSessionIdentity } from "../messages/prompt.js";
import { tailScan, type TailScan, type TraceTailDeps, type TraceTailTarget } from "./trace-tail.js";

/** The veto a follow-up check produces: the view state it demands and its bounded reason. */
export interface FollowUpVeto {
  state: "refused" | "deferred";
  reason: string;
}

export type TailScanner = (target: TraceTailTarget, anchorMs: number, history: NonNullable<HandoffState["artifact"]["traceHistory"]>, deps?: TraceTailDeps) => Promise<TailScan>;

export interface FollowUpDeps {
  /** The bounded tail scan; tests count or script it. */
  scan?: TailScanner;
  trace?: TraceTailDeps;
}

function sameSession(left: AgentSessionIdentity, right: AgentSessionIdentity): boolean {
  return left.source === right.source && left.agent === right.agent && left.kind === right.kind && left.value === right.value;
}

function artifactCode(error: HandoffError): string {
  switch (error.code) {
    case "HANDOFF_ARTIFACT_MISSING": return "missing";
    case "HANDOFF_ARTIFACT_INVALID": return "invalid";
    case "HANDOFF_ARTIFACT_OVERSIZED": return "oversized";
    case "HANDOFF_ARTIFACT_UNTRUSTED": return "untrusted";
    default: return "unavailable";
  }
}

/**
 * Decide whether the handed-off lane may still retire. `readArtifact` is the
 * existing trusted artifact read (`readHandoffArtifact`), whose digest must
 * equal the accepted `sha256`; its mtime is never consulted.
 */
export async function followUpVeto(state: HandoffState, readArtifact: () => Promise<HandoffArtifact>, deps: FollowUpDeps = {}): Promise<FollowUpVeto | undefined> {
  const refused = (reason: string): FollowUpVeto => ({ state: "refused", reason });
  if (HANDOFF_TRACE_KINDS[state.child.agentKind] === undefined) return refused("trace_unsupported_kind");
  const { artifact, nativeSession } = state;
  if (artifact.mtimeMs === undefined || artifact.sha256 === null) return refused("trace_anchor_missing");
  if (artifact.traceHistory === undefined) return refused("trace_history_missing");
  if (nativeSession === null || !sameSession(artifact.traceHistory.session, nativeSession)) return refused("trace_history_stale");
  let fresh: HandoffArtifact;
  try {
    fresh = await readArtifact();
  } catch (error) {
    if (error instanceof HandoffError) return refused(`trace_artifact_${artifactCode(error)}`);
    throw error;
  }
  if (fresh.sha256 !== artifact.sha256) return refused("trace_artifact_changed");
  const target: TraceTailTarget = {
    agentKind: state.child.agentKind,
    session: nativeSession,
    ...(state.child.workspace === undefined ? {} : { workspace: state.child.workspace }),
  };
  // F13: the PERSISTED anchor, never the fresh file's mtime.
  const scan = await (deps.scan ?? tailScan)(target, artifact.mtimeMs, artifact.traceHistory, deps.trace);
  switch (scan.kind) {
    case "none": return undefined;
    case "failure": return refused(`trace_${scan.failure}`);
    case "pending_tail": return refused("trace_pending_tail");
    case "user_turn": return refused("trace_follow_up");
    case "ambiguous": return refused(`trace_ambiguous:${scan.reason}`);
  }
}
