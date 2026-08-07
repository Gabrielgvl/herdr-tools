import { describe, expect, it, vi } from "vitest";
import { HerdrCli, type PiExec } from "../../src/cli.js";
import { boundedEvidence, closeWithReadback, errorEvidence } from "../../src/mutations.js";

const signal = new AbortController().signal;

function response(id: string, result: unknown) {
  return { stdout: JSON.stringify({ id, result }), stderr: "", code: 0, killed: false };
}

function snapshot(present: boolean) {
  return { present, values: present ? ["target", { environment: { SECRET: "hidden" } }] : [] };
}

function optionsFor(exec: ReturnType<typeof vi.fn<PiExec>>) {
  return exec.mock.calls.map((call) => call[2]?.signal);
}

describe("completed close mutation preservation and reconciliation", () => {
  it("bounds large evidence and handles non-serializable evidence", () => {
    expect(boundedEvidence({ value: "x".repeat(3_000) })).toMatchObject({ truncated: true });
    expect(boundedEvidence(1n)).toEqual({ summary: "[evidence unavailable]", truncated: true });
    expect(boundedEvidence(Array.from({ length: 20 }, (_, index) => index))).toContain("[4 items omitted]");
    expect(boundedEvidence({ a: { b: { c: { d: { e: { f: { g: "deep" } } } } } } })).toMatchObject({ a: { b: { c: { d: { e: { f: "[nested value omitted]" } } } } } });
    expect(errorEvidence({ code: "BROKEN", message: "failed", details: { environment: { SECRET: "hidden" } } })).toMatchObject({ code: "BROKEN", message: "failed" });
    expect(errorEvidence({ code: 1, message: 2 })).toMatchObject({ message: expect.stringContaining("[object Object]") });
    expect(errorEvidence("primitive")).toEqual({ message: "primitive" });
  });
  it("returns the authoritative operation ID/result and uses a fresh readback signal", async () => {
    const signals: AbortSignal[] = [];
    const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv, options) => {
      signals.push(options.signal!);
      if (argv[1] === "close") return response("close-42", { ok: true, environment: { TOKEN: "hidden" } });
      return response("readback", {});
    });
    const result = await closeWithReadback({
      cli: new HerdrCli(exec), argv: ["pane", "close", "target"], signal, targetId: "target",
      readback: async (readbackSignal) => { expect(readbackSignal).not.toBe(signal); return snapshot(false); },
      targetPresent: (value) => value.present,
      summarize: (value) => value
    });
    expect(result).toMatchObject({ operationId: "close-42", mutationResult: { ok: true }, reconciled: false, readback: { present: false } });
    expect(JSON.stringify(result)).not.toContain("hidden");
    expect(optionsFor(exec)[0]).toBe(signal);
    expect(optionsFor(exec)[1]).not.toBe(signal);
  });

  it("reconciles one lost/invalid response when absence is proven", async () => {
    const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[1] === "close") return { stdout: "not-json", stderr: "lost response", code: 0, killed: false };
      return response("readback", {});
    });
    const result = await closeWithReadback({
      cli: new HerdrCli(exec), argv: ["tab", "close", "target"], signal, targetId: "target",
      readback: async () => snapshot(false), targetPresent: (value) => value.present, summarize: (value) => value
    });
    expect(result).toEqual({ readback: { present: false, values: [] }, reconciled: true });
    expect(JSON.stringify(result)).not.toContain("No result provided");
  });

  it("throws typed uncertainty when the target remains after a lost response", async () => {
    const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[1] === "close") throw new DOMException("aborted", "AbortError");
      return response("readback", {});
    });
    await expect(closeWithReadback({
      cli: new HerdrCli(exec), argv: ["pane", "close", "target"], signal, targetId: "target",
      readback: async () => snapshot(true), targetPresent: (value) => value.present, summarize: (value) => value
    })).rejects.toMatchObject({ code: "MUTATION_UNCERTAIN", details: { targetId: "target", readback: { status: "target_present" } } });
  });

  it("throws typed uncertainty when readback is unavailable, including bounded evidence", async () => {
    const exec = vi.fn<PiExec>().mockResolvedValue(response("close-42", { ok: true }));
    await expect(closeWithReadback<{ present: boolean }>({
      cli: new HerdrCli(exec), argv: ["tab", "close", "target"], signal, targetId: "target",
      readback: async () => { throw Object.assign(new Error("readback failed"), { code: "CLI_TIMEOUT", details: { environment: { SECRET: "hidden" } } }); },
      targetPresent: (value) => value.present, summarize: (value) => value
    })).rejects.toMatchObject({ code: "MUTATION_UNCERTAIN", details: { targetId: "target", readback: { code: "CLI_TIMEOUT" } } });
  });

  it("does not reconcile a pre-dispatch abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const exec = vi.fn<PiExec>();
    const readback = vi.fn();
    await expect(closeWithReadback({
      cli: new HerdrCli(exec), argv: ["pane", "close", "target"], signal: controller.signal, targetId: "target",
      readback, targetPresent: (value: { present: boolean }) => value.present, summarize: (value: { present: boolean }) => value
    })).rejects.toMatchObject({ code: "ABORTED" });
    expect(exec).not.toHaveBeenCalled();
    expect(readback).not.toHaveBeenCalled();
  });

  it("reports unavailable readback when a readback returns no snapshot", async () => {
    const exec = vi.fn<PiExec>().mockResolvedValue(response("close-42", { ok: true }));
    await expect(closeWithReadback({
      cli: new HerdrCli(exec), argv: ["pane", "close", "target"], signal, targetId: "target",
      readback: async () => undefined as never, targetPresent: (value: { present: boolean }) => value.present, summarize: (value: { present: boolean }) => value
    })).rejects.toMatchObject({ code: "MUTATION_UNCERTAIN", details: { readback: { status: "unavailable" } } });
  });

  it("throws uncertainty for a valid mutation response with contradictory post-state", async () => {
    const exec = vi.fn<PiExec>().mockResolvedValue(response("close-42", { ok: true }));
    await expect(closeWithReadback({
      cli: new HerdrCli(exec), argv: ["pane", "close", "target"], signal, targetId: "target",
      readback: async () => snapshot(true), targetPresent: (value) => value.present, summarize: (value) => value
    })).rejects.toMatchObject({ code: "MUTATION_UNCERTAIN", details: { original: { operationId: "close-42" } } });
  });

  it("bounds and scrubs nested original and readback evidence", async () => {
    const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[1] === "close") return { stdout: "malformed", stderr: "x".repeat(10_000), code: 0, killed: false };
      return response("readback", {});
    });
    await expect(closeWithReadback({
      cli: new HerdrCli(exec), argv: ["pane", "close", "target"], signal, targetId: "target",
      readback: async () => snapshot(true), targetPresent: (value) => value.present, summarize: (value) => value
    })).rejects.toSatisfy((error: unknown) => JSON.stringify(error).length < 10_000 && !JSON.stringify(error).includes("SECRET"));
  });
});
