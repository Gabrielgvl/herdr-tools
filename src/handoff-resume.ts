import { resolveManagerSession, type EffectiveContext } from "./context.js";
import {
  HandoffError,
  currentHandoffOwner,
  readHandoffArtifact,
  readHandoffProvenance,
  readHandoffState,
  type HandoffAllocation
} from "./handoff.js";
import { requirePromptTargetIdentity } from "./messages/prompt.js";
import { snapshotIdentityRecords } from "./messages/prompt-target.js";
import type { AgentSessionIdentity } from "./messages/prompt.js";

export class HandoffResumeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HandoffResumeError";
  }
}

function refuse(code: string, message: string): never {
  throw new HandoffResumeError(code, message);
}

function sameSession(left: AgentSessionIdentity, right: AgentSessionIdentity): boolean {
  return left.source === right.source
    && left.agent === right.agent
    && left.kind === right.kind
    && left.value === right.value;
}

/**
 * Observe one existing run from the same native manager session. This function
 * never delivers input, launches a child, mutates ownership, or restores a
 * supervisor.
 */
export async function resumeHandoff(run: HandoffAllocation, caller: EffectiveContext) {
  const managerSession = resolveManagerSession(caller.snapshot, caller.context.paneId);
  if (managerSession === null) refuse("MANAGER_SESSION_UNAVAILABLE", "Native manager session is unavailable");

  const provenance = await readHandoffProvenance(run);
  const owner = currentHandoffOwner(provenance);
  if (owner === null) {
    refuse("HANDOFF_PROVENANCE_MISSING", "This run has no native manager-session provenance");
  }
  if (!sameSession(managerSession, owner)) {
    refuse("HANDOFF_OWNER_MISMATCH", "A different native manager session owns this run; no takeover occurred");
  }

  const state = await readHandoffState(run);
  const childSession = state.nativeSession;
  if (state.child.terminalId === null || childSession === null) {
    refuse("HANDOFF_CHILD_UNBOUND", "The original child identity was not durably bound");
  }
  const matches = caller.snapshot.panes.filter((pane) => pane.terminal_id === state.child.terminalId);
  if (matches.length > 1) refuse("HANDOFF_CHILD_AMBIGUOUS", "More than one pane claims the recorded child terminal");

  let currentChild:
    | {
        presence: "present";
        paneId: string;
        terminalId: string;
        agentName: string;
        agentKind: string;
        agentSession: AgentSessionIdentity;
        state: unknown;
      }
    | { presence: "absent" };
  if (matches.length === 0) {
    if (state.child.paneId !== null && caller.snapshot.panes.some((pane) => pane.pane_id === state.child.paneId)) {
      refuse("HANDOFF_CHILD_CHANGED", "The recorded child pane has a different occupant");
    }
    currentChild = { presence: "absent" };
  } else {
    const pane = matches[0]!;
    let live;
    try {
      live = requirePromptTargetIdentity(snapshotIdentityRecords(caller.snapshot, pane.pane_id), pane.pane_id);
    } catch {
      refuse("HANDOFF_CHILD_CHANGED", "The live child identity is unavailable or contradictory");
    }
    if (live.terminalId !== state.child.terminalId
      || live.agentName !== state.child.agentName
      || live.agentKind !== state.child.agentKind
      || !sameSession(live.agentSession, childSession)) {
      refuse("HANDOFF_CHILD_CHANGED", "The live child does not match the durable identity");
    }
    currentChild = {
      presence: "present",
      paneId: live.paneId,
      terminalId: live.terminalId,
      agentName: live.agentName,
      agentKind: live.agentKind,
      agentSession: live.agentSession,
      state: pane.agent_status
    };
  }

  let artifact;
  try {
    artifact = await readHandoffArtifact(run);
  } catch (error) {
    /* c8 ignore next -- readHandoffArtifact exposes only typed HandoffError refusals. */
    if (error instanceof HandoffError) {
      refuse("HANDOFF_ARTIFACT_UNAVAILABLE", "The retained handoff artifact is unavailable or untrusted");
    }
    /* c8 ignore next -- readHandoffArtifact exposes only typed HandoffError refusals; preserve a foreign programming error. */
    throw error;
  }
  if (state.artifact.sha256 !== null && state.artifact.sha256 !== artifact.sha256) {
    refuse("HANDOFF_ARTIFACT_CHANGED", "The retained handoff artifact does not match the recorded digest");
  }

  return {
    runId: run.runId,
    task: provenance.task,
    lifecycle: state.lifecycle.state,
    currentChild,
    artifactPath: run.artifactPath,
    recordedArtifact: state.artifact,
    currentArtifact: { status: artifact.status, sha256: artifact.sha256, bytes: artifact.bytes },
    observationOnly: true as const,
    supervisionRestored: false as const,
    replayed: false as const,
    ownershipTransferred: false as const
  };
}
