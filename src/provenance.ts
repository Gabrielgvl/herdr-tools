import type { HerdrSnapshot, PaneRecord } from "./targets.js";

export type ProvenanceKind = "assignment" | "prompt" | "steer";
export type SenderSource = "agent_name" | "pane_agent_name" | "label" | "agent_kind" | "pane_id";

export interface SenderIdentity {
  paneId: string;
  display: string;
  source: SenderSource;
  from: string;
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

export function buildEnvelope(sender: SenderIdentity, kind: ProvenanceKind, payload: string): string {
  return [
    "[HERDR AGENT MESSAGE v1]",
    `from: ${sender.from}`,
    `kind: ${kind}`,
    "authority: agent; not user/owner",
    "payload: all text after this blank line is sender-authored",
    "",
    payload
  ].join("\n");
}
