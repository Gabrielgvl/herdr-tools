import { describe, expect, it } from "vitest";
import {
  assertSubscriptionAck,
  encodeSocketRequest,
  isPaneRecordEvent,
  parseAgentSession,
  parsePaneRecord,
  parseSocketLine,
  subscribeParams,
  SupervisionProtocolError,
  SUPERVISION_EVENT_KINDS,
  SUPERVISION_MAX_LINE_BYTES,
  SUPERVISION_SUBSCRIPTIONS,
  type SupervisionSocketEvent,
} from "../../src/supervision/protocol.js";

const pane = {
  pane_id: "p1",
  terminal_id: "t1",
  tab_id: "tab1",
  workspace_id: "w1",
  agent_status: "working",
  revision: 7,
  agent: "pi",
  agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "s1" },
  label: "worker",
};

describe("supervision socket protocol", () => {
  it("encodes bounded request frames without accepting control fields or oversized complete frames", () => {
    const frame = encodeSocketRequest("request-1", "agent.prompt", { target: "w1:p1", text: "hello" });
    expect(JSON.parse(frame)).toEqual({ id: "request-1", method: "agent.prompt", params: { target: "w1:p1", text: "hello" } });
    expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(SUPERVISION_MAX_LINE_BYTES);
    expect(() => encodeSocketRequest("request\n1", "ping", {})).toThrow(SupervisionProtocolError);
    expect(() => encodeSocketRequest("request-1", "ping", null as never)).toThrow(/params are malformed/u);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => encodeSocketRequest("request-1", "ping", circular)).toThrow(/not serializable/u);
    expect(() => encodeSocketRequest("request-1", "agent.prompt", { text: "x".repeat(SUPERVISION_MAX_LINE_BYTES) })).toThrow(/accepted bound/u);
  });

  it("publishes exactly the fixed global subscription set", () => {
    expect(subscribeParams()).toEqual({ subscriptions: SUPERVISION_SUBSCRIPTIONS.map((type) => ({ type })) });
    expect(SUPERVISION_SUBSCRIPTIONS).not.toContain("pane.agent_status_changed");
    expect(SUPERVISION_EVENT_KINDS).toContain("pane_updated");
  });

  it("parses replies, failures, and accepted events, and ignores unrelated kinds", () => {
    expect(parseSocketLine(JSON.stringify({ id: "1", result: { type: "pong" } }))).toEqual({ kind: "reply", id: "1", result: { type: "pong" } });
    expect(parseSocketLine(JSON.stringify({ id: "1", error: { code: "bad", message: "no" } }))).toEqual({ kind: "failure", id: "1", error: { code: "bad", message: "no" } });
    expect(parseSocketLine(JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } }))).toMatchObject({ kind: "event", event: "pane_closed" });
    expect(parseSocketLine(JSON.stringify({ event: "layout_updated", data: { type: "layout_updated" } }))).toEqual({ kind: "ignored" });
  });

  it("refuses every malformed line rather than skipping it", () => {
    const refusals: Array<[string, string]> = [
      ["not json", "not JSON"],
      [JSON.stringify([1]), "not an object"],
      [JSON.stringify({ id: "" }), "usable identifier"],
      [JSON.stringify({ id: "1" }), "neither result nor error"],
      [JSON.stringify({ id: "1", error: "nope" }), "error is malformed"],
      [JSON.stringify({ id: "1", error: { code: 1, message: "m" } }), "usable identifier"],
      [JSON.stringify({ id: "1", result: {}, error: { code: "bad", message: "m" } }), "both result and error"],
      [JSON.stringify({ other: 1 }), "neither a reply nor an event"],
      [JSON.stringify({ event: "pane_updated", data: [] }), "event data is malformed"],
    ];
    for (const [line, fragment] of refusals) {
      expect(() => parseSocketLine(line), line).toThrow(new RegExp(fragment, "u"));
      expect(() => parseSocketLine(line)).toThrow(SupervisionProtocolError);
    }
    expect(() => parseSocketLine(`"${"x".repeat(SUPERVISION_MAX_LINE_BYTES)}"`)).toThrow(/accepted bound/u);
  });

  it("validates a pane record and rejects every field protocol 22 requires", () => {
    expect(parsePaneRecord(pane)).toEqual({
      paneId: "p1", terminalId: "t1", tabId: "tab1", workspaceId: "w1",
      agentStatus: "working", revision: 7, agentKind: "pi",
      agentSession: { source: "herdr:pi", agent: "pi", kind: "id", value: "s1" }, label: "worker",
    });
    expect(parsePaneRecord({ ...pane, agent: null, agent_session: null, label: null })).toEqual({
      paneId: "p1", terminalId: "t1", tabId: "tab1", workspaceId: "w1", agentStatus: "working", revision: 7,
    });
    expect(parsePaneRecord({ ...pane, state_change_seq: 4 })).toMatchObject({ stateChangeSeq: 4 });
    expect(parsePaneRecord({ ...pane, state_change_seq: null })).not.toHaveProperty("stateChangeSeq");
    expect(() => parsePaneRecord({ ...pane, state_change_seq: -1 })).toThrow(/counter is malformed/u);
    expect(() => parsePaneRecord(null)).toThrow(/pane record is malformed/u);
    expect(() => parsePaneRecord({ ...pane, pane_id: "p\n1" })).toThrow(/usable identifier/u);
    expect(() => parsePaneRecord({ ...pane, agent_status: "spinning" })).toThrow(/agent status is malformed/u);
    expect(() => parsePaneRecord({ ...pane, revision: -1 })).toThrow(/counter is malformed/u);
    expect(() => parsePaneRecord({ ...pane, revision: 1.5 })).toThrow(/counter is malformed/u);
    expect(() => parsePaneRecord({ ...pane, agent_session: { source: "s", agent: "a", kind: "k" } })).toThrow(/usable identifier/u);
    expect(() => parseAgentSession("nope")).toThrow(/agent session is malformed/u);
  });

  it("validates each known event kind's own fields and refuses the malformed ones", () => {
    expect(isPaneRecordEvent("pane_updated")).toBe(true);
    expect(isPaneRecordEvent("pane_closed")).toBe(false);

    const accepted = (data: Record<string, unknown>): SupervisionSocketEvent =>
      parseSocketLine(JSON.stringify({ event: data.type, data })) as SupervisionSocketEvent;
    expect(accepted({ type: "pane_updated", pane })).toMatchObject({ paneId: "p1", pane: { paneId: "p1", revision: 7 } });
    expect(accepted({ type: "pane_closed", pane_id: "p1", workspace_id: "w1" })).toMatchObject({ paneId: "p1" });
    expect(accepted({ type: "pane_moved", previous_pane_id: "p0", pane })).toMatchObject({ paneId: "p1", previousPaneId: "p0" });

    // A known kind whose own fields are unusable is refused rather than accepted
    // and routed to no observer.
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ type: "pane_updated", pane: { revision: 1 } }, "usable identifier"],
      [{ type: "pane_updated" }, "pane record is malformed"],
      [{ type: "pane_closed", workspace_id: "w1" }, "usable identifier"],
      [{ type: "pane_exited", pane_id: "" }, "usable identifier"],
      [{ type: "pane_agent_detected", pane_id: 7 }, "usable identifier"],
      [{ type: "pane_moved", pane }, "usable identifier"],
      [{ type: "pane_updated", pane, extra: 1 }, "does not match its kind"],
    ];
    for (const [data, fragment] of refusals) {
      const event = data.extra === undefined ? data.type : "pane_closed";
      expect(() => parseSocketLine(JSON.stringify({ event, data })), JSON.stringify(data)).toThrow(new RegExp(fragment, "u"));
      expect(() => parseSocketLine(JSON.stringify({ event, data }))).toThrow(SupervisionProtocolError);
    }
  });

  it("requires the subscription acknowledgement before any event", () => {
    expect(() => assertSubscriptionAck({ type: "subscription_started" })).not.toThrow();
    expect(() => assertSubscriptionAck({ type: "pong" })).toThrow(/did not acknowledge/u);
    expect(() => assertSubscriptionAck(undefined)).toThrow(/did not acknowledge/u);
  });
});
