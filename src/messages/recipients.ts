import { randomUUID } from "node:crypto";
import type { HerdrSnapshot } from "../targets.js";
import type { ProfileKind } from "../profiles/types.js";
import type { AttachmentCapability } from "../profiles/capability.js";

export interface RecipientIdentity {
  agentName?: string;
  agentId?: string;
}

export interface RecipientRecord extends RecipientIdentity {
  paneId: string;
  recipientKey: string;
  profileName: string;
  kind: ProfileKind;
  capable: boolean;
  reason: string;
}

export interface RecipientVerification {
  verified: boolean;
  reason: string;
  identity: RecipientIdentity;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function recipientIdentity(snapshot: HerdrSnapshot, paneId: string): RecipientIdentity {
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  const agent = snapshot.agents.find((candidate) => candidate.pane_id === paneId);
  return {
    agentName: stringValue(agent?.name) ?? stringValue(pane?.agent_name) ?? stringValue(pane?.agent),
    agentId: stringValue(agent?.agent_id) ?? stringValue(pane?.agent_id)
  };
}

export function verifyRecipient(snapshot: HerdrSnapshot, record: RecipientRecord | undefined): RecipientVerification {
  if (!record) return { verified: false, reason: "recipient capability is not registered in this runtime", identity: {} };
  const identity = recipientIdentity(snapshot, record.paneId);
  if (!record.capable) return { verified: false, reason: record.reason, identity };
  if (identity.agentName !== record.agentName || identity.agentId !== record.agentId) {
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
    this.records.set(record.paneId, { ...record });
  }

  get(paneId: string): RecipientRecord | undefined {
    const record = this.records.get(paneId);
    return record ? { ...record } : undefined;
  }

  recordFor(profileName: string, paneId: string, recipientKey: string, capability: AttachmentCapability & { kind: ProfileKind }, identity: RecipientIdentity): RecipientRecord {
    const record: RecipientRecord = {
      paneId,
      recipientKey,
      profileName,
      kind: capability.kind,
      capable: capability.capable,
      reason: capability.reason,
      ...identity
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
