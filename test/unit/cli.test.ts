import { describe, expect, it, vi } from "vitest";
import { CliProtocolError, HerdrCli, type PiExec } from "../../src/cli.js";
import type { StdinExec } from "../../src/exec-stdin.js";

const signal = new AbortController().signal;

function response(stdout: string, code = 0, stderr = "", killed = false) {
  return { stdout, stderr, code, killed };
}

describe("HerdrCli", () => {
  it("uses pi.exec with herdr and an argv array, signal, and bounded timeout", async () => {
    const exec = vi.fn<PiExec>().mockResolvedValue(response('{"id":"req-1","result":{"ok":true}}'));
    const cli = new HerdrCli(exec, 4321);

    await expect(cli.runJson(["pane", "get", "w1:p1"], signal)).resolves.toEqual({
      id: "req-1",
      result: { ok: true }
    });
    expect(exec).toHaveBeenCalledWith("herdr", ["pane", "get", "w1:p1"], { signal, timeout: 4321 });
  });

  it("gives agent startup its two-minute readiness window plus an exec margin", async () => {
    const exec = vi.fn<PiExec>().mockResolvedValue(response('{"id":"start","result":{"agent":{"name":"worker"}}}'));
    const cli = new HerdrCli(exec);
    await cli.runJson(["agent", "start", "worker", "--timeout", "120000"], signal);
    expect(exec).toHaveBeenCalledWith("herdr", ["agent", "start", "worker", "--timeout", "120000"], { signal, timeout: 125_000 });
    await cli.runJson(["agent", "start", "worker"], signal);
    expect(exec).toHaveBeenLastCalledWith("herdr", ["agent", "start", "worker"], { signal, timeout: 125_000 });
    await cli.runJson(["agent", "start", "worker", "--timeout", "invalid"], signal);
    expect(exec).toHaveBeenLastCalledWith("herdr", ["agent", "start", "worker", "--timeout", "invalid"], { signal, timeout: 125_000 });
  });

  it("keeps the exec margin above a larger requested startup timeout", async () => {
    const exec = vi.fn<PiExec>().mockResolvedValue(response('{"id":"start","result":{"agent":{"name":"worker"}}}'));
    const cli = new HerdrCli(exec);
    await cli.runJson(["agent", "start", "worker", "--timeout", "300000"], signal);
    expect(exec).toHaveBeenCalledWith("herdr", ["agent", "start", "worker", "--timeout", "300000"], { signal, timeout: 305_000 });
  });

  it("preserves a completed mutation response when abort arrives after execution", async () => {
    const controller = new AbortController();
    const exec = vi.fn<PiExec>().mockImplementation(async () => {
      controller.abort();
      return response('{"id":"split","result":{"pane":{"pane_id":"p2"}}}');
    });
    await expect(new HerdrCli(exec).runJson(["pane", "split"], controller.signal, true)).resolves.toMatchObject({ result: { pane: { pane_id: "p2" } } });
  });

  it("rejects malformed JSON envelopes and preserves bounded evidence", async () => {
    const exec = vi.fn<PiExec>().mockResolvedValue(response("not-json", 2, "bad request"));
    const cli = new HerdrCli(exec, 1000);

    await expect(cli.runJson(["api", "snapshot"], signal)).rejects.toMatchObject({
      code: "CLI_PROTOCOL_ERROR",
      details: { exitCode: 2, stderr: "bad request", stdout: "not-json" }
    });
  });

  it("rejects malformed successful JSON and incompatible envelopes", async () => {
    const malformed = vi.fn<PiExec>().mockResolvedValue(response("not-json"));
    await expect(new HerdrCli(malformed).runJson(["api", "snapshot"], signal)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR", details: { stdout: "not-json" } });

    const nonObject = vi.fn<PiExec>().mockResolvedValue(response("[]"));
    await expect(new HerdrCli(nonObject).runJson(["api", "snapshot"], signal)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });

    const invalidId = vi.fn<PiExec>().mockResolvedValue(response('{"id":1,"result":null}'));
    await expect(new HerdrCli(invalidId).runJson(["api", "snapshot"], signal)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });

    const extra = vi.fn<PiExec>().mockResolvedValue(response('{"id":"x","result":{},"extra":true}'));
    await expect(new HerdrCli(extra).runJson(["api", "snapshot"], signal)).rejects.toBeInstanceOf(CliProtocolError);

    const missing = vi.fn<PiExec>().mockResolvedValue(response('{"id":"x"}'));
    await expect(new HerdrCli(missing).runJson(["api", "snapshot"], signal)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("caps text and JSON output before retaining evidence", async () => {
    const large = "x".repeat(60_000);
    const exec = vi.fn<PiExec>().mockResolvedValue(response(large, 9, "e".repeat(60_000)));
    const cli = new HerdrCli(exec, 1000, 128);

    await expect(cli.runText(["pane", "read", "w1:p1"], signal)).rejects.toMatchObject({
      code: "CLI_PROTOCOL_ERROR",
      details: {
        stdoutTruncated: true,
        stderrTruncated: true,
        stdout: expect.stringContaining("[output truncated]"),
        stderr: expect.stringContaining("[output truncated]")
      }
    });

    const malformed = vi.fn<PiExec>().mockResolvedValue(response("x".repeat(1000)));
    await expect(new HerdrCli(malformed, 1000, 128).runJson(["api", "snapshot"], signal)).rejects.toMatchObject({ details: { stdout: expect.stringContaining("[output truncated]") } });
  });

  it("reports killed commands as CLI timeouts and bounds successful text", async () => {
    const killed = vi.fn<PiExec>().mockResolvedValue(response("partial", 137, "timed out", true));
    await expect(new HerdrCli(killed).runJson(["status"], signal)).rejects.toMatchObject({ code: "CLI_TIMEOUT" });
    await expect(new HerdrCli(killed).runText(["status"], signal)).rejects.toMatchObject({ code: "CLI_TIMEOUT" });

    const success = vi.fn<PiExec>().mockResolvedValue(response("status\n"));
    await expect(new HerdrCli(success).runText(["status"], signal)).resolves.toBe("status\n");

    const large = vi.fn<PiExec>().mockResolvedValue(response("x".repeat(256)));
    const boundedCli = new HerdrCli(large, 1000, 128);
    await expect(boundedCli.runTextResult(["pane", "read"], signal)).resolves.toMatchObject({ truncated: true, value: expect.not.stringContaining("[output truncated]") });
    await expect(boundedCli.runText(["pane", "read"], signal)).resolves.toContain("[output truncated]");
  });

  it("rejects before execution when already aborted and observes abort after execution", async () => {
    const controller = new AbortController();
    controller.abort();
    const exec = vi.fn<PiExec>();
    await expect(new HerdrCli(exec).runText(["status"], controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
    expect(exec).not.toHaveBeenCalled();

    const late = new AbortController();
    const lateExec = vi.fn<PiExec>().mockImplementation(async () => {
      late.abort();
      return response("status");
    });
    await expect(new HerdrCli(lateExec).runText(["status"], late.signal)).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("preserves abort errors, protocol errors, and execution failures", async () => {
    const domAbort = vi.fn<PiExec>().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    await expect(new HerdrCli(domAbort).runText(["status"], signal)).rejects.toMatchObject({ code: "ABORTED" });

    const protocol = new CliProtocolError("CLI_PROTOCOL_ERROR", "already structured");
    const structured = vi.fn<PiExec>().mockRejectedValue(protocol);
    await expect(new HerdrCli(structured).runText(["status"], signal)).rejects.toBe(protocol);

    const error = vi.fn<PiExec>().mockRejectedValue(new Error("missing executable"));
    await expect(new HerdrCli(error).runText(["status"], signal)).rejects.toMatchObject({ code: "CLI_NOT_FOUND", details: { cause: "missing executable" } });

    const stringFailure = vi.fn<PiExec>().mockRejectedValue("missing executable");
    await expect(new HerdrCli(stringFailure).runText(["status"], signal)).rejects.toMatchObject({ code: "CLI_NOT_FOUND", details: { cause: "missing executable" } });
  });

  it("uses the narrow stdin executor without placing the payload in argv", async () => {
    const input = "payload that must stay out of argv";
    const exec = vi.fn<PiExec>().mockResolvedValue(response('{"id":"prompt","result":{"ok":true}}'));
    const stdinExec = vi.fn<StdinExec>().mockResolvedValue(response('{"id":"prompt","result":{"ok":true}}'));
    const cli = new HerdrCli(exec, 1000, 1000, stdinExec);
    await expect(cli.runJsonWithStdin(["agent", "prompt", "w1:p2", "--stdin"], input, signal)).resolves.toMatchObject({ id: "prompt" });
    expect(exec).not.toHaveBeenCalled();
    expect(stdinExec).toHaveBeenCalledWith("herdr", ["agent", "prompt", "w1:p2", "--stdin"], input, { signal, timeout: 1000 });

    const incompatible = vi.fn<StdinExec>().mockResolvedValue(response("", 2, "unknown option --stdin; payload that must stay out of argv"));
    await expect(new HerdrCli(exec, 1000, 1000, incompatible).runJsonWithStdin(["agent", "prompt", "w1:p2", "--stdin"], input, signal)).rejects.toMatchObject({
      code: "CLI_INCOMPATIBLE",
      details: { evidence: "omitted_for_stdin_delivery", exitCode: 2, stderrPresent: true, stdoutPresent: false, stdoutBytes: 0 }
    });
  });

  it("never exposes stdout or stderr text for stdin deliveries, including partial echoes", async () => {
    const input = "line one of the plan\nline two of the plan\nline three of the plan";
    const partialEcho = `error near "${input.slice(0, 24)}" while submitting`;
    const exec = vi.fn<PiExec>().mockResolvedValue(response(""));

    const failing = vi.fn<StdinExec>().mockResolvedValue(response(partialEcho.slice(0, 12), 1, partialEcho));
    const failure = await new HerdrCli(exec, 1000, 40, failing).runJsonWithStdin(["agent", "prompt", "w1:p2", "--stdin"], input, signal).catch((error: CliProtocolError) => error);
    expect(failure).toBeInstanceOf(CliProtocolError);
    const failureDetails = (failure as CliProtocolError).details;
    expect(failureDetails).toEqual({
      exitCode: 1,
      killed: false,
      evidence: "omitted_for_stdin_delivery",
      stdoutPresent: true,
      stdoutBytes: 12,
      stdoutTruncated: false,
      stderrPresent: true,
      stderrBytes: Buffer.byteLength(partialEcho, "utf8"),
      stderrTruncated: true
    });
    expect(JSON.stringify(failureDetails)).not.toContain(input.slice(0, 12));

    const malformed = vi.fn<StdinExec>().mockResolvedValue(response(`not json: ${input}`));
    const parseFailure = await new HerdrCli(exec, 1000, 1000, malformed).runJsonWithStdin(["agent", "prompt", "w1:p2", "--stdin"], input, signal).catch((error: CliProtocolError) => error);
    expect((parseFailure as CliProtocolError).code).toBe("CLI_PROTOCOL_ERROR");
    expect((parseFailure as CliProtocolError).details).toEqual({ evidence: "omitted_for_stdin_delivery", stdoutPresent: true, stdoutBytes: Buffer.byteLength(`not json: ${input}`, "utf8"), stdoutTruncated: false });
    expect(JSON.stringify((parseFailure as CliProtocolError).details)).not.toContain("line one");

    const killed = vi.fn<StdinExec>().mockResolvedValue(response("", 1, "", true));
    await expect(new HerdrCli(exec, 1000, 1000, killed).runJsonWithStdin(["agent", "prompt", "w1:p2", "--stdin"], input, signal)).rejects.toMatchObject({ code: "CLI_TIMEOUT", details: { killed: true, stderrPresent: false } });

    const argvFailure = vi.fn<PiExec>().mockResolvedValue(response("plain text", 1, "plain error"));
    await expect(new HerdrCli(argvFailure).runJson(["pane", "get", "w1:p1"], signal)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR", details: { stdout: "plain text", stderr: "plain error" } });
  });

  it("passes the caller signal to every call and reports cancellation", async () => {
    const controller = new AbortController();
    const exec = vi.fn<PiExec>().mockImplementation(async (_command, _argv, options) => {
      const execSignal = options.signal;
      if (!execSignal) throw new Error("missing signal");
      expect(execSignal).toBe(controller.signal);
      await new Promise<void>((_resolve, reject) => {
        execSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      return response("");
    });
    const promise = new HerdrCli(exec).runText(["status"], controller.signal);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
  });
});
