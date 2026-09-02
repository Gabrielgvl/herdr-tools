import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { HerdrSnapshot } from "../targets.js";
import type { ProfileKind } from "../profiles/types.js";
import type { AttachmentCapability } from "../profiles/capability.js";
import { requirePromptTargetIdentity, samePromptTargetIdentity, type AgentSessionIdentity, type PromptTargetIdentity } from "./prompt.js";

/**
 * Identity persisted for an attachment recipient. `agentId` is diagnostic metadata
 * only; recipient verification never uses it as an identity binding.
 */
export interface RecipientIdentity {
  paneId: string;
  terminalId: string;
  agentName: string;
  agentKind: string;
  agentSession: AgentSessionIdentity;
  agentId?: string;
}

export interface RecipientRecord extends RecipientIdentity {
  recipientKey: string;
  profileName: string;
  kind: ProfileKind;
  capable: boolean;
  reason: string;
  /** Present only after AGY's provisional supervisor was strengthened. */
  agyStrengthened?: true;
  /** The exact tools-owned directory granted to a strengthened AGY process. */
  attachmentDirectory?: string;
}

export interface RecipientRegistrationEvidence {
  agyStrengthened?: true;
  attachmentDirectory?: string;
}

export interface RecipientVerification {
  verified: boolean;
  reason: string;
  /** Full values are retained only for the current internal verification step. */
  identity: Partial<RecipientIdentity>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function snapshotIdentityRecords(snapshot: HerdrSnapshot, paneId: string): Record<string, unknown>[] {
  const panes = snapshot.panes.filter((candidate) => candidate.pane_id === paneId);
  const agents = snapshot.agents.filter((candidate) => candidate.pane_id === paneId);
  if (panes.length !== 1 || agents.length !== 1) return [];
  return [panes[0]!, agents[0]!];
}

/** Join the snapshot's pane and agent records; missing or contradictory identity is empty. */
export function recipientIdentity(snapshot: HerdrSnapshot, paneId: string): Partial<RecipientIdentity> {
  const records = snapshotIdentityRecords(snapshot, paneId);
  if (records.length === 0) return {};
  try {
    const identity = requirePromptTargetIdentity(records, paneId);
    const agent = snapshot.agents.find((candidate) => candidate.pane_id === paneId)!;
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId)!;
    const agentId = stringValue(agent.agent_id) ?? stringValue(pane.agent_id);
    return {
      paneId: identity.paneId,
      terminalId: identity.terminalId,
      agentName: identity.agentName,
      agentKind: identity.agentKind,
      agentSession: identity.agentSession,
      ...(agentId ? { agentId } : {})
    };
  } catch {
    return {};
  }
}

function identityString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\0\r\n]/u.test(value);
}

function completeIdentity(value: Partial<RecipientIdentity>): value is RecipientIdentity {
  return identityString(value.paneId)
    && identityString(value.terminalId)
    && identityString(value.agentName)
    && identityString(value.agentKind)
    && typeof value.agentSession === "object"
    && value.agentSession !== null
    && identityString(value.agentSession.source)
    && identityString(value.agentSession.agent)
    && identityString(value.agentSession.kind)
    && identityString(value.agentSession.value)
    && value.agentSession.agent === value.agentKind;
}

function validAttachmentDirectory(value: unknown): value is string {
  return identityString(value) && isAbsolute(value) && resolve(value) === value;
}

function asPromptIdentity(value: RecipientIdentity): PromptTargetIdentity {
  return {
    paneId: value.paneId,
    terminalId: value.terminalId,
    agentName: value.agentName,
    agentKind: value.agentKind,
    agentSession: value.agentSession
  };
}

export function sameRecipientIdentity(left: RecipientIdentity, right: RecipientIdentity): boolean {
  return samePromptTargetIdentity(asPromptIdentity(left), asPromptIdentity(right));
}

export function verifyRecipient(snapshot: HerdrSnapshot, record: RecipientRecord | undefined): RecipientVerification {
  if (!record) return { verified: false, reason: "recipient capability is not registered in this runtime", identity: {} };
  const identity = recipientIdentity(snapshot, record.paneId);
  if (!record.capable) return { verified: false, reason: record.reason, identity };
  if (record.kind === "agy" && (record.agyStrengthened !== true || !validAttachmentDirectory(record.attachmentDirectory))) {
    return { verified: false, reason: "AGY recipient has no strengthened attachment capability", identity };
  }
  if (!completeIdentity(identity)) {
    return { verified: false, reason: "recipient identity is unavailable or contradictory in the authoritative snapshot", identity };
  }
  if (identity.paneId !== record.paneId || !sameRecipientIdentity(identity, record) || record.kind !== identity.agentKind) {
    return { verified: false, reason: "recipient identity no longer matches the authoritative snapshot", identity };
  }
  return { verified: true, reason: record.reason, identity };
}

export function mintRecipientKey(): string {
  return randomUUID();
}

export class RecipientRegistry {
  private readonly records = new Map<string, RecipientRecord>();

  register(record: RecipientRecord): void {
    if (!completeIdentity(record) || record.kind !== record.agentKind) {
      throw new Error("Recipient registration identity does not match the launched profile and pane");
    }
    if (record.kind === "agy" && (record.agyStrengthened !== true || !validAttachmentDirectory(record.attachmentDirectory))) {
      throw new Error("AGY recipient registration requires strengthened exact identity and attachment directory");
    }
    this.records.set(record.paneId, { ...record, agentSession: { ...record.agentSession } });
  }

  get(paneId: string): RecipientRecord | undefined {
    const record = this.records.get(paneId);
    return record ? { ...record, agentSession: { ...record.agentSession } } : undefined;
  }

  recordFor(profileName: string, paneId: string, recipientKey: string, capability: AttachmentCapability & { kind: ProfileKind }, identity: PromptTargetIdentity & { agentId?: string }, evidence: RecipientRegistrationEvidence = {}): RecipientRecord {
    if (identity.paneId !== paneId || capability.kind !== identity.agentKind || !completeIdentity(identity)) {
      throw new Error("Recipient registration identity does not match the launched profile and pane");
    }
    if (capability.kind === "agy" && (evidence.agyStrengthened !== true || !validAttachmentDirectory(evidence.attachmentDirectory))) {
      throw new Error("AGY recipient registration requires strengthened exact identity and attachment directory");
    }
    const record: RecipientRecord = {
      paneId,
      terminalId: identity.terminalId,
      agentName: identity.agentName,
      agentKind: identity.agentKind,
      agentSession: { ...identity.agentSession },
      ...(identity.agentId ? { agentId: identity.agentId } : {}),
      recipientKey,
      profileName,
      kind: capability.kind,
      capable: capability.capable,
      reason: capability.reason,
      ...(capability.kind === "agy" ? { agyStrengthened: true as const, attachmentDirectory: evidence.attachmentDirectory! } : {})
    };
    this.register(record);
    return record;
  }

  reset(): void {
    this.records.clear();
  }

  get size(): number {
    return this.records.size;
  }
}
