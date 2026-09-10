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
 * The fixed global subscription set. Herdr 0.8.2 serves one request per
 * connection, so a connection that has subscribed can never subscribe again and
 * every supervisor is served from exactly this set.
 *
 * `pane.created` is deliberately absent: a supervisor binds to a pane that
 * already exists, so a creation event for it can only ever be historical, and
 * subscribing to it would only add replay volume.
 */
export const SUPERVISION_SUBSCRIPTIONS = [
  "pane.updated",
  "pane.closed",
  "pane.exited",
  "pane.moved",
  "pane.agent_detected",
] as const;

/** Event kinds this monitor accepts; anything else on the stream is ignored. */
export const SUPERVISION_EVENT_KINDS = [
  "pane_updated",
  "pane_closed",
  "pane_exited",
  "pane_moved",
  "pane_agent_detected",
] as const;
export type SupervisionEventKind = (typeof SUPERVISION_EVENT_KINDS)[number];

/** Event kinds that carry a full `PaneInfo` and can therefore be revision-anchored. */
export const PANE_RECORD_EVENT_KINDS = ["pane_updated", "pane_moved"] as const;

/** The largest complete newline-delimited JSON frame, including its delimiter. */
export const SUPERVISION_MAX_LINE_BYTES = 262_144;

function usableRequestString(value: unknown, field: string): value is string {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new SupervisionProtocolError("Herdr socket request field is malformed", { field });
  }
  return true;
}

export function encodeSocketRequest(id: string, method: string, params: Record<string, unknown>): string {
  usableRequestString(id, "id");
  usableRequestString(method, "method");
  if (!record(params)) throw new SupervisionProtocolError("Herdr socket request params are malformed");
  let frame: string;
  try {
    frame = `${JSON.stringify({ id, method, params })}\n`;
  } catch {
    throw new SupervisionProtocolError("Herdr socket request is not serializable");
  }
  if (Buffer.byteLength(frame, "utf8") > SUPERVISION_MAX_LINE_BYTES) {
    throw new SupervisionProtocolError("Herdr socket request exceeds the accepted bound", { limitBytes: SUPERVISION_MAX_LINE_BYTES });
  }
  return frame;
}

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
  stateChangeSeq?: number;
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

/**
 * An event validated at the protocol boundary.
 *
 * Every accepted event carries the pane it concerns and, for a `PaneInfo`-bearing
 * kind, the whole validated record. A known kind whose own fields are malformed
 * is refused rather than accepted and routed nowhere: silently dropping it would
 * lose lifecycle evidence without degrading the monitor, which is exactly the
 * failure the fail-closed contract exists to prevent.
 */
export interface SupervisionSocketEvent {
  kind: "event";
  event: SupervisionEventKind;
  data: Record<string, unknown>;
  /** The pane this event concerns. Always usable. */
  paneId: string;
  /** Present for `PANE_RECORD_EVENT_KINDS`; validated at the boundary. */
  pane?: SupervisionPaneRecord;
  /** Present for `pane_moved`; validated at the boundary. */
  previousPaneId?: string;
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

/** Validate a `PaneInfo`. Every field required by protocol 22 must be present and usable. */
export function parsePaneRecord(value: unknown): SupervisionPaneRecord {
  if (!record(value)) throw new SupervisionProtocolError("Herdr pane record is malformed", { field: "pane" });
  return {
    paneId: requiredString(value.pane_id, "pane_id"),
    terminalId: requiredString(value.terminal_id, "terminal_id"),
    tabId: requiredString(value.tab_id, "tab_id"),
    workspaceId: requiredString(value.workspace_id, "workspace_id"),
    agentStatus: agentStatus(value.agent_status),
    revision: requiredCounter(value.revision, "revision"),
    ...(value.state_change_seq === undefined || value.state_change_seq === null ? {} : { stateChangeSeq: requiredCounter(value.state_change_seq, "state_change_seq") }),
    ...(optionalString(value, "agent") === undefined ? {} : { agentKind: optionalString(value, "agent") }),
    ...(optionalAgentSession(value) === undefined ? {} : { agentSession: optionalAgentSession(value) }),
    ...(optionalString(value, "label") === undefined ? {} : { label: optionalString(value, "label") }),
  };
}

export function isPaneRecordEvent(kind: SupervisionEventKind): boolean {
  return (PANE_RECORD_EVENT_KINDS as readonly string[]).includes(kind);
}

/**
 * Validate one accepted event's own fields. A `PaneInfo`-bearing kind must carry
 * a complete pane record, `pane_moved` must additionally be atomic, and a thin
 * kind must carry a usable pane id.
 */
function validateEvent(event: SupervisionEventKind, data: Record<string, unknown>): Omit<SupervisionSocketEvent, "kind" | "event" | "data"> {
  if (data.type !== event) throw new SupervisionProtocolError("Herdr socket event type does not match its kind", { event });
  if (!isPaneRecordEvent(event)) return { paneId: requiredString(data.pane_id, "pane_id") };
  const pane = parsePaneRecord(data.pane);
  if (event !== "pane_moved") return { paneId: pane.paneId, pane };
  return { paneId: pane.paneId, pane, previousPaneId: requiredString(data.previous_pane_id, "previous_pane_id") };
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
    if (own(parsed, "result") && own(parsed, "error")) {
      throw new SupervisionProtocolError("Herdr socket reply carries both result and error", { id });
    }
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
  const kind = event as SupervisionEventKind;
  return { kind: "event", event: kind, data: parsed.data, ...validateEvent(kind, parsed.data) };
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
