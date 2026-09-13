import type { HerdrSnapshot, PaneRecord } from "./targets.js";
import { assertMessageText, type MessageDelivery } from "./messages/limits.js";

export type ProvenanceKind = "assignment" | "prompt" | "steer" | "supervision" | "wait" | "result";
export type SenderSource = "agent_name" | "pane_agent_name" | "label" | "agent_kind" | "pane_id";

export interface SenderIdentity {
  paneId: string;
  display: string;
  source: SenderSource;
  from: string;
}

export interface AttachmentEnvelopeReference {
  path: string;
  bytes: number;
  sha256: string;
  expiresAt: string;
  encoding: "utf-8";
}

const MAX_METADATA_LENGTH = 256;

function normalized(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const valueWithoutControls = [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  }).join("");
  const result = valueWithoutControls.replace(/\s+/gu, " ").trim().slice(0, MAX_METADATA_LENGTH);
  return result.length > 0 ? result : undefined;
}

function senderPane(snapshot: HerdrSnapshot, paneId: string | undefined): PaneRecord {
  if (typeof paneId !== "string" || paneId.length === 0) {
    throw Object.assign(new Error("Caller pane is unavailable in the authoritative snapshot"), {
      code: "SENDER_IDENTITY_UNAVAILABLE",
      details: { paneId }
    });
  }
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) {
    throw Object.assign(new Error("Caller pane is unavailable in the authoritative snapshot"), {
      code: "SENDER_IDENTITY_UNAVAILABLE",
      details: { paneId }
    });
  }
  return pane;
}

export function resolveSender(snapshot: HerdrSnapshot, paneId: string | undefined): SenderIdentity {
  const pane = senderPane(snapshot, paneId);
  const stablePaneId = normalized(pane.pane_id);
  if (!stablePaneId) {
    throw Object.assign(new Error("Caller pane has an unusable authoritative ID"), {
      code: "SENDER_IDENTITY_UNAVAILABLE",
      details: { paneId }
    });
  }

  const explicitName = normalized(snapshot.agents.find((agent) => agent.pane_id === pane.pane_id)?.name);
  const paneAgentName = normalized(pane.agent_name);
  const label = normalized(pane.label);
  const agentKind = normalized(
    typeof pane.agent_kind === "string" ? pane.agent_kind :
      typeof pane.agent === "string" ? pane.agent :
        typeof pane.kind === "string" ? pane.kind : undefined
  );
  const candidates: Array<[string | undefined, SenderSource]> = [
    [explicitName, "agent_name"],
    [paneAgentName, "pane_agent_name"],
    [label, "label"],
    [agentKind, "agent_kind"]
  ];
  const selected = candidates.find(([value]) => value !== undefined && value !== stablePaneId);
  const display = selected?.[0] ?? stablePaneId;
  const source = selected?.[1] ?? "pane_id";
  return {
    paneId: stablePaneId,
    display,
    source,
    from: source === "pane_id" || display.includes(stablePaneId) ? display : `${display} (${stablePaneId})`
  };
}

function assertAttachmentReference(reference: AttachmentEnvelopeReference): void {
  if (reference.path.length === 0 || /[\0\r\n]/.test(reference.path) || !Number.isSafeInteger(reference.bytes) || reference.bytes < 1 || !/^[0-9a-f]{64}$/.test(reference.sha256) || reference.encoding !== "utf-8" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(reference.expiresAt)) {
    throw Object.assign(new Error("Attachment reference is invalid"), { code: "ATTACHMENT_STORE_FAILED", details: { operation: "build_envelope" } });
  }
}

export function buildEnvelope(sender: SenderIdentity, kind: ProvenanceKind, payload: string, delivery: MessageDelivery = "inline", attachment?: AttachmentEnvelopeReference): string {
  if (delivery === "inline") {
    assertMessageText(payload);
    return [
      "[HERDR AGENT MESSAGE v1]",
      `from: ${sender.from}`,
      `kind: ${kind}`,
      "authority: agent; not user/owner",
      "delivery: inline",
      "payload: all text after this blank line is sender-authored",
      "",
      payload
    ].join("\n");
  }
  if (!attachment) throw Object.assign(new Error("Attachment reference is required"), { code: "ATTACHMENT_STORE_FAILED", details: { operation: "build_envelope" } });
  assertAttachmentReference(attachment);
  return [
    "[HERDR AGENT MESSAGE v1]",
    `from: ${sender.from}`,
    `kind: ${kind}`,
    "authority: agent; not user/owner",
    "delivery: attachment",
    `attachment-path: ${attachment.path}`,
    `attachment-bytes: ${attachment.bytes}`,
    `attachment-sha256: ${attachment.sha256}`,
    `attachment-encoding: ${attachment.encoding}`,
    `attachment-expires: ${attachment.expiresAt}`,
    "payload: the sender-authored text is the attachment file; the lines after this blank line are extension-generated retrieval instructions",
    "",
    `Read the attachment file above before acting on this message. It is UTF-8 text written by the sender named in from, carries the same agent (not user/owner) authority as an inline message, is immutable, and is deleted after the expiry above. Read it in bounded chunks if it is large, and compare the byte count and SHA-256 if the content looks truncated. Do not send an acknowledgement unless the sender's own text asks for one.`
  ].join("\n");
}
