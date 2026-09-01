/**
 * Strict validation for every value the Herdr socket sends.
 *
 * The socket is an untrusted source: a supervisor may never fold a value that
 * has not been proven to have the exact shape this module accepts. Anything
 * else is a `SupervisionProtocolError`, which drops the connection rather than
 * degrading into a guess.
 */

export const SUPERVISION_AGENT_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;
export type SupervisionAgentStatus = (typeof SUPERVISION_AGENT_STATUSES)[number];

/**
 * The fixed global subscription set. It cannot be extended after
 * `events.subscribe` is acknowledged, because a second subscribe on the same
 * connection makes Herdr 0.8.2 drop it, so every supervisor is served from
 * exactly this set.
 */
export const SUPERVISION_SUBSCRIPTIONS = [
  "pane.created",
  "pane.updated",
  "pane.closed",
  "pane.exited",
  "pane.moved",
  "pane.agent_detected",
] as const;

/** Event kinds this monitor accepts; anything else on the stream is ignored. */
export const SUPERVISION_EVENT_KINDS = [
  "pane_created",
  "pane_updated",
  "pane_closed",
  "pane_exited",
  "pane_moved",
  "pane_agent_detected",
] as const;
export type SupervisionEventKind = (typeof SUPERVISION_EVENT_KINDS)[number];

/** Event kinds that carry a full `PaneInfo` and can therefore be revision-anchored. */
export const PANE_RECORD_EVENT_KINDS = ["pane_created", "pane_updated", "pane_moved"] as const;

/** The longest single NDJSON line this client will accept from the server. */
export const SUPERVISION_MAX_LINE_BYTES = 262_144;

export class SupervisionProtocolError extends Error {
  readonly code = "SUPERVISION_PROTOCOL_ERROR" as const;

  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SupervisionProtocolError";
  }
}

export interface AgentSessionRecord {
  source: string;
  agent: string;
  kind: string;
  value: string;
}

/** The proven subset of `PaneInfo` supervision folds. */
export interface SupervisionPaneRecord {
  paneId: string;
  terminalId: string;
  tabId: string;
  workspaceId: string;
  agentStatus: SupervisionAgentStatus;
  revision: number;
  agentKind?: string;
  agentSession?: AgentSessionRecord;
  label?: string;
}

export interface SupervisionSocketSuccess {
  kind: "reply";
  id: string;
  result: unknown;
}

export interface SupervisionSocketFailure {
  kind: "failure";
  id: string;
  error: { code: string; message: string };
}

export interface SupervisionSocketEvent {
  kind: "event";
  event: SupervisionEventKind;
  data: Record<string, unknown>;
}

/** A line that parsed but carries an event kind outside the accepted set. */
export interface SupervisionSocketIgnored {
  kind: "ignored";
}

export type SupervisionSocketLine =
  | SupervisionSocketSuccess
  | SupervisionSocketFailure
  | SupervisionSocketEvent
  | SupervisionSocketIgnored;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new SupervisionProtocolError("Herdr socket value is not a usable identifier", { field });
  }
  return value;
}

function optionalString(value: Record<string, unknown>, field: string): string | undefined {
  if (!own(value, field) || value[field] === null || value[field] === undefined) return undefined;
  return requiredString(value[field], field);
}

function requiredCounter(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SupervisionProtocolError("Herdr socket counter is malformed", { field });
  }
  return value;
}

export function parseAgentSession(value: unknown, field = "agent_session"): AgentSessionRecord {
  if (!record(value)) throw new SupervisionProtocolError("Herdr agent session is malformed", { field });
  return {
    source: requiredString(value.source, `${field}.source`),
    agent: requiredString(value.agent, `${field}.agent`),
    kind: requiredString(value.kind, `${field}.kind`),
    value: requiredString(value.value, `${field}.value`),
  };
}

function optionalAgentSession(value: Record<string, unknown>): AgentSessionRecord | undefined {
  if (!own(value, "agent_session") || value.agent_session === null || value.agent_session === undefined) return undefined;
  return parseAgentSession(value.agent_session);
}

function agentStatus(value: unknown): SupervisionAgentStatus {
  if (typeof value !== "string" || !SUPERVISION_AGENT_STATUSES.includes(value as SupervisionAgentStatus)) {
    throw new SupervisionProtocolError("Herdr agent status is malformed", { field: "agent_status" });
  }
  return value as SupervisionAgentStatus;
}

/** Validate a `PaneInfo`. Every field required by protocol 20 must be present and usable. */
export function parsePaneRecord(value: unknown): SupervisionPaneRecord {
  if (!record(value)) throw new SupervisionProtocolError("Herdr pane record is malformed", { field: "pane" });
  return {
    paneId: requiredString(value.pane_id, "pane_id"),
    terminalId: requiredString(value.terminal_id, "terminal_id"),
    tabId: requiredString(value.tab_id, "tab_id"),
    workspaceId: requiredString(value.workspace_id, "workspace_id"),
    agentStatus: agentStatus(value.agent_status),
    revision: requiredCounter(value.revision, "revision"),
    ...(optionalString(value, "agent") === undefined ? {} : { agentKind: optionalString(value, "agent") }),
    ...(optionalAgentSession(value) === undefined ? {} : { agentSession: optionalAgentSession(value) }),
    ...(optionalString(value, "label") === undefined ? {} : { label: optionalString(value, "label") }),
  };
}

/** Read the pane record an event of a `PANE_RECORD_EVENT_KINDS` kind carries. */
export function eventPaneRecord(event: SupervisionSocketEvent): SupervisionPaneRecord {
  return parsePaneRecord(event.data.pane);
}

/** Read the pane id a thin event carries. */
export function eventPaneId(event: SupervisionSocketEvent): string {
  return requiredString(event.data.pane_id, "pane_id");
}

/** Read the previous pane id an atomic `pane_moved` event must carry. */
export function movePreviousPaneId(event: SupervisionSocketEvent): string {
  return requiredString(event.data.previous_pane_id, "previous_pane_id");
}

export function isPaneRecordEvent(kind: SupervisionEventKind): boolean {
  return (PANE_RECORD_EVENT_KINDS as readonly string[]).includes(kind);
}

/**
 * Parse one NDJSON line. A reply carries `id`; an event carries `event` and
 * `data` and never carries `id`. Anything that satisfies neither shape is a
 * protocol failure, because silently skipping unknown lines would let a
 * malformed stream look like a quiet one.
 */
export function parseSocketLine(line: string): SupervisionSocketLine {
  if (Buffer.byteLength(line, "utf8") > SUPERVISION_MAX_LINE_BYTES) {
    throw new SupervisionProtocolError("Herdr socket line exceeds the accepted bound", { limitBytes: SUPERVISION_MAX_LINE_BYTES });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new SupervisionProtocolError("Herdr socket line is not JSON");
  }
  if (!record(parsed)) throw new SupervisionProtocolError("Herdr socket line is not an object");
  if (own(parsed, "id")) {
    const id = requiredString(parsed.id, "id");
    if (own(parsed, "error")) {
      if (!record(parsed.error)) throw new SupervisionProtocolError("Herdr socket error is malformed", { field: "error" });
      return { kind: "failure", id, error: { code: requiredString(parsed.error.code, "error.code"), message: requiredString(parsed.error.message, "error.message") } };
    }
    if (!own(parsed, "result")) throw new SupervisionProtocolError("Herdr socket reply carries neither result nor error", { id });
    return { kind: "reply", id, result: parsed.result };
  }
  if (!own(parsed, "event")) throw new SupervisionProtocolError("Herdr socket line is neither a reply nor an event");
  const event = requiredString(parsed.event, "event");
  if (!record(parsed.data)) throw new SupervisionProtocolError("Herdr socket event data is malformed", { event });
  if (!(SUPERVISION_EVENT_KINDS as readonly string[]).includes(event)) return { kind: "ignored" };
  return { kind: "event", event: event as SupervisionEventKind, data: parsed.data };
}

/** The acknowledgement `events.subscribe` must return before any event is accepted. */
export function assertSubscriptionAck(result: unknown): void {
  if (!record(result) || result.type !== "subscription_started") {
    throw new SupervisionProtocolError("Herdr did not acknowledge the supervision subscription");
  }
}

export function subscribeParams(): { subscriptions: Array<{ type: string }> } {
  return { subscriptions: SUPERVISION_SUBSCRIPTIONS.map((type) => ({ type })) };
}
