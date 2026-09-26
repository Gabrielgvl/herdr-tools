import { describe, expect, it } from "vitest";
import {
  DAEMON_MAX_LINE_BYTES,
  DAEMON_PROTOCOL_VERSION,
  DaemonProtocolError,
  encodeDaemonAck,
  encodeDaemonErrorLine,
  encodeDaemonFailure,
  encodeDaemonHello,
  encodeDaemonRequest,
  encodeDaemonResult,
  parseDaemonLine,
} from "../../src/daemon/protocol.js";

describe("daemon protocol framing", () => {
  it("frames the version hello and ack as one bounded line each", () => {
    expect(encodeDaemonHello()).toBe(`${JSON.stringify({ type: "hello", version: DAEMON_PROTOCOL_VERSION })}\n`);
    expect(encodeDaemonHello(7)).toBe(`${JSON.stringify({ type: "hello", version: 7 })}\n`);
    expect(encodeDaemonAck()).toBe(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION })}\n`);
    expect(parseDaemonLine(encodeDaemonHello(3).trimEnd())).toEqual({ kind: "hello", version: 3 });
    expect(parseDaemonLine(encodeDaemonAck(4).trimEnd())).toEqual({ kind: "ack", version: 4 });
    for (const version of [0, -1, 1.5, Number.NaN, "1" as never]) {
      expect(() => encodeDaemonHello(version)).toThrow(DaemonProtocolError);
      expect(() => encodeDaemonAck(version)).toThrow(DaemonProtocolError);
    }
  });

  it("frames correlated requests and replies with the shared 256 KiB bound", () => {
    expect(encodeDaemonRequest("id-1", "echo", { text: "hi" })).toBe(`${JSON.stringify({ id: "id-1", method: "echo", params: { text: "hi" } })}\n`);
    expect(parseDaemonLine(encodeDaemonRequest("id-1", "echo", { text: "hi" }).trimEnd())).toEqual({
      kind: "request",
      id: "id-1",
      method: "echo",
      params: { text: "hi" },
    });
    expect(parseDaemonLine(encodeDaemonResult("id-1", { ok: true }).trimEnd())).toEqual({ kind: "reply", id: "id-1", result: { ok: true } });
    // A result of undefined cannot be distinguished from a missing field, so
    // it is framed as null — the reply must always carry its result.
    expect(parseDaemonLine(encodeDaemonResult("id-1", undefined).trimEnd())).toEqual({ kind: "reply", id: "id-1", result: null });
    const failure = parseDaemonLine(encodeDaemonFailure("id-1", "SOME_CODE", "it failed").trimEnd());
    expect(failure).toEqual({ kind: "failure", id: "id-1", error: { code: "SOME_CODE", message: "it failed" } });
  });

  it("refuses unencodable or oversized frames before they are written", () => {
    for (const [id, method, params] of [
      ["", "echo", {}],
      ["bad\nid", "echo", {}],
      ["id", "", {}],
      ["id", "echo", null],
      ["id", "echo", []],
    ] as Array<[string, string, never]>) {
      expect(() => encodeDaemonRequest(id, method, params)).toThrow(DaemonProtocolError);
    }
    expect(() => encodeDaemonRequest("id", "echo", { big: "x".repeat(DAEMON_MAX_LINE_BYTES) })).toThrow(DaemonProtocolError);
    expect(() => encodeDaemonRequest("id", "echo", { bigint: 1n })).toThrow(DaemonProtocolError);
    expect(() => encodeDaemonResult("id", "x".repeat(DAEMON_MAX_LINE_BYTES))).toThrow(DaemonProtocolError);
    expect(() => encodeDaemonResult("bad\nid", {})).toThrow(DaemonProtocolError);
    expect(() => encodeDaemonFailure("bad\nid", "CODE", "msg")).toThrow(DaemonProtocolError);
  });

  it("keeps every error line bounded even when the message is long", () => {
    const line = encodeDaemonErrorLine("PROTOCOL_MISMATCH", "m".repeat(5_000));
    expect(Buffer.byteLength(line, "utf8")).toBeLessThan(DAEMON_MAX_LINE_BYTES);
    const parsed = parseDaemonLine(line.trimEnd());
    expect(parsed).toEqual({ kind: "error", error: { code: "PROTOCOL_MISMATCH", message: "m".repeat(512) } });
    const failure = parseDaemonLine(encodeDaemonFailure("id", "c".repeat(2_000), "ok").trimEnd());
    expect(failure).toEqual({ kind: "failure", id: "id", error: { code: "c".repeat(512), message: "ok" } });
  });
});

describe("daemon protocol parsing", () => {
  it("accepts exactly the frames each peer may send", () => {
    expect(parseDaemonLine(`{"type":"error","error":{"code":"PROTOCOL_MISMATCH","message":"no"}}`)).toEqual({
      kind: "error",
      error: { code: "PROTOCOL_MISMATCH", message: "no" },
    });
    expect(parseDaemonLine(`{"id":"r1","result":{"ok":true}}`)).toEqual({ kind: "reply", id: "r1", result: { ok: true } });
    expect(parseDaemonLine(`{"id":"r1","error":{"code":"X","message":"m"}}`)).toEqual({
      kind: "failure",
      id: "r1",
      error: { code: "X", message: "m" },
    });
    // Fields beyond the contract are tolerated, mirroring the supervision parser.
    expect(parseDaemonLine(`{"type":"ack","version":2,"extra":true}`)).toEqual({ kind: "ack", version: 2 });
  });

  it("rejects anything that is not a proven frame", () => {
    const bad: string[] = [
      "x".repeat(DAEMON_MAX_LINE_BYTES + 1),
      "not json",
      "[1,2]",
      "42",
      "{}",
      `{"type":"mystery"}`,
      `{"type":""}`,
      `{"type":"hello"}`,
      `{"type":"hello","version":0}`,
      `{"type":"hello","version":"1"}`,
      `{"type":"ack","version":1.5}`,
      `{"type":"error"}`,
      `{"type":"error","error":{"code":"X"}}`,
      `{"type":"error","error":{"code":"X","message":""}}`,
      `{"id":""}`,
      `{"id":"r1"}`,
      `{"id":"r1","result":{},"error":{"code":"X","message":"m"}}`,
      `{"id":"r1","error":{}}`,
      `{"id":"r1","error":{"code":"X","message":"m"},"method":"echo","params":{}}`,
      `{"id":"r1","method":"echo","result":{}}`,
      `{"id":"r1","method":"","params":{}}`,
      `{"id":"r1","method":"echo"}`,
      `{"id":"r1","method":"echo","params":[]}`,
      `{"id":"r1","method":"echo","params":null}`,
      `{"id":"bad\nid","result":{}}`,
    ];
    for (const line of bad) {
      expect(() => parseDaemonLine(line), line.slice(0, 60)).toThrow(DaemonProtocolError);
    }
  });

  it("accepts a frame at the bound and refuses one byte over", () => {
    const pad = DAEMON_MAX_LINE_BYTES - `{"type":"ack","version":1,"pad":""}`.length;
    const atBound = `{"type":"ack","version":1,"pad":"${"x".repeat(pad)}"}`;
    expect(Buffer.byteLength(atBound, "utf8")).toBe(DAEMON_MAX_LINE_BYTES);
    expect(parseDaemonLine(atBound)).toEqual({ kind: "ack", version: 1 });
  });
});
