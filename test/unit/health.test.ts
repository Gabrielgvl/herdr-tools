import { describe, expect, it, vi } from "vitest";
import { CliProtocolError, HerdrCli, type PiExec } from "../../src/cli.js";
import { mapPreflightFailure, MAX_HEALTH_STATUS_LENGTH, MAX_HEALTH_VERSION_LENGTH, parseHealth, preflightCompatibility } from "../../src/health.js";
import { createPaneTool } from "../../src/tools/pane.js";

const healthy = JSON.stringify({
  client: { version: "0.8.0", protocol: 19 },
  server: { status: "running", version: "0.8.0", protocol: 19, compatible: true }
});

const context = { workspaceId: "w1", tabId: "t1", paneId: "p1" };
const validHealthClient = { version: "0.8.0", protocol: 19 };
const validHealthServer = { status: "running", version: "0.8.0", protocol: 19 };

function healthDetails(client: unknown = validHealthClient, server: unknown = validHealthServer, overrides: Record<string, unknown> = {}) {
  return { client, server, socketReachable: true, compatible: true, ...overrides };
}

function productionRename(stdout: string, code = 0, stderr = "") {
  const calls: string[][] = [];
  const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
    calls.push([...argv]);
    return { stdout, stderr, code, killed: false };
  });
  const cli = new HerdrCli(exec);
  const tool = createPaneTool({ cli, context, preflight: async (signal) => { await preflightCompatibility(cli, signal); } });
  const promise = tool.execute("id", { operation: "rename", target: "p1", label: "new" } as never, new AbortController().signal, undefined, { cwd: "/repo", signal: new AbortController().signal } as never);
  return { promise, calls };
}

describe("Herdr compatibility preflight", () => {
  it("parses the shared health contract without exposing transport details", () => {
    expect(parseHealth(healthy)).toEqual({
      client: { version: "0.8.0", protocol: 19 },
      server: { status: "running", version: "0.8.0", protocol: 19 },
      socketReachable: true,
      compatible: true
    });
  });

  it("allows a compatible running backend", async () => {
    await expect(preflightCompatibility({ runText: vi.fn(async () => healthy) }, new AbortController().signal)).resolves.toMatchObject({ compatible: true, socketReachable: true });
  });

  it("accepts health fields at their explicit size boundaries", () => {
    const version = "v".repeat(MAX_HEALTH_VERSION_LENGTH);
    const status = "s".repeat(MAX_HEALTH_STATUS_LENGTH);
    expect(parseHealth(JSON.stringify({
      client: { version, protocol: 19 },
      server: { status, version, protocol: 19, compatible: true }
    }))).toEqual({
      client: { version, protocol: 19 },
      server: { status, version, protocol: 19 },
      socketReachable: false,
      compatible: true
    });
  });

  it.each([
    ["client version", { client: { version: "v".repeat(MAX_HEALTH_VERSION_LENGTH + 1), protocol: 19 }, server: { status: "running", version: "0.8.0", protocol: 19, compatible: true } }],
    ["server version", { client: { version: "0.8.0", protocol: 19 }, server: { status: "running", version: "v".repeat(MAX_HEALTH_VERSION_LENGTH + 1), protocol: 19, compatible: true } }],
    ["server status", { client: { version: "0.8.0", protocol: 19 }, server: { status: "s".repeat(MAX_HEALTH_STATUS_LENGTH + 1), version: "0.8.0", protocol: 19, compatible: true } }]
  ] as const)("rejects oversized %s health fields before mutation preflight", (_name, output) => {
    expect(() => parseHealth(JSON.stringify(output))).toThrowError(expect.objectContaining({ code: "CLI_INCOMPATIBLE" }));
  });

  it("accepts degraded stopped health without server metadata and reports it as unavailable", async () => {
    const degraded = JSON.stringify({ client: { version: "0.8.0", protocol: 19 }, server: { status: "stopped" } });
    expect(parseHealth(degraded)).toEqual({
      client: { version: "0.8.0", protocol: 19 },
      server: { status: "stopped" },
      socketReachable: false
    });
    const { promise, calls } = productionRename(degraded);
    await expect(promise).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE", details: { health: { server: { status: "stopped" }, socketReachable: false } } });
    expect(calls).toEqual([["status", "--json"]]);
  });

  it("accepts explicit null degraded metadata and reports it as unavailable", async () => {
    const degraded = JSON.stringify({ client: { version: "0.8.0", protocol: 19 }, server: { status: "stopped", version: null, protocol: null, compatible: null } });
    expect(parseHealth(degraded)).toEqual({
      client: { version: "0.8.0", protocol: 19 },
      server: { status: "stopped" },
      socketReachable: false
    });
    const { promise, calls } = productionRename(degraded);
    await expect(promise).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    expect(calls).toEqual([["status", "--json"]]);
  });

  it("keeps stopped and incompatible preflight errors bounded to typed health", async () => {
    const version = "v".repeat(MAX_HEALTH_VERSION_LENGTH);
    const status = "s".repeat(MAX_HEALTH_STATUS_LENGTH);
    const stopped = productionRename(JSON.stringify({ client: { version, protocol: 19 }, server: { status } }));
    const stoppedError = await stopped.promise.catch((error: unknown) => error);
    expect(stoppedError).toMatchObject({ code: "BACKEND_UNAVAILABLE", details: { health: { client: { version }, server: { status }, socketReachable: false } } });
    expect(Object.keys((stoppedError as { details: Record<string, unknown> }).details)).toEqual(["health"]);
    expect(JSON.stringify(stoppedError)).not.toContain("[truncated]");
    expect(stopped.calls).toEqual([["status", "--json"]]);

    const incompatible = productionRename(JSON.stringify({ client: { version, protocol: 19 }, server: { status: "running", version, protocol: 18, compatible: false } }));
    const incompatibleError = await incompatible.promise.catch((error: unknown) => error);
    expect(incompatibleError).toMatchObject({ code: "CLI_INCOMPATIBLE", details: { health: { client: { version }, server: { status: "running", version, protocol: 18 }, socketReachable: true, compatible: false } } });
    expect(Object.keys((incompatibleError as { details: Record<string, unknown> }).details)).toEqual(["health"]);
    expect(JSON.stringify(incompatibleError)).not.toContain("[truncated]");
    expect(incompatible.calls).toEqual([["status", "--json"]]);
  });

  it.each([
    ["stopped status", { client: { version: "0.8.0", protocol: 19 }, server: { status: "s".repeat(MAX_HEALTH_STATUS_LENGTH + 1) } }],
    ["incompatible server version", { client: { version: "0.8.0", protocol: 19 }, server: { status: "running", version: "v".repeat(MAX_HEALTH_VERSION_LENGTH + 1), protocol: 18, compatible: false } }]
  ] as const)("rejects oversized %s through production preflight without mutation", async (_name, output) => {
    const { promise, calls } = productionRename(JSON.stringify(output));
    await expect(promise).rejects.toMatchObject({ code: "CLI_INCOMPATIBLE" });
    expect(calls).toEqual([["status", "--json"]]);
  });

  it.each([
    ["empty client version", healthy.replace('"version":"0.8.0"', '"version":""')],
    ["empty server version", '{"client":{"version":"0.8.0","protocol":19},"server":{"status":"running","version":"","protocol":19,"compatible":true}}'],
    ["non-finite protocol", healthy.replace('"protocol":19', '"protocol":1e400')],
    ["non-integer protocol", healthy.replace('"protocol":19', '"protocol":19.5')],
    ["invalid protocol", healthy.replace('"protocol":19', '"protocol":0')],
    ["running without server version", '{"client":{"version":"0.8.0","protocol":19},"server":{"status":"running","protocol":19,"compatible":true}}'],
    ["running without server protocol", '{"client":{"version":"0.8.0","protocol":19},"server":{"status":"running","version":"0.8.0","compatible":true}}'],
    ["running without compatible flag", '{"client":{"version":"0.8.0","protocol":19},"server":{"status":"running","version":"0.8.0","protocol":19}}'],
    ["malformed status", healthy.replace('"status":"running"', '"status":123')],
    ["empty status", healthy.replace('"status":"running"', '"status":""')],
    ["malformed compatible", healthy.replace('"compatible":true', '"compatible":"true"')]
  ] as const)("rejects %s health before dispatching a mutation", async (_name, output) => {
    const { promise, calls } = productionRename(output);
    await expect(promise).rejects.toMatchObject({ code: "CLI_INCOMPATIBLE" });
    expect(calls).toEqual([["status", "--json"]]);
  });

  it("redacts raw failed health output while retaining safe typed context", async () => {
    const { promise, calls } = productionRename('{"socket":"/secret/socket","token":"super-secret"}', 1, "Authorization: Bearer credential");
    const error = await promise.catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "BACKEND_UNAVAILABLE", details: { exitCode: 1, killed: false, stdoutTruncated: false, stderrTruncated: false } });
    expect(JSON.stringify(error)).not.toContain("/secret/socket");
    expect(JSON.stringify(error)).not.toContain("super-secret");
    expect(JSON.stringify(error)).not.toContain("Bearer credential");
    expect(calls).toEqual([["status", "--json"]]);
  });

  const malformedHealthCases = [
    ["undefined", undefined],
    ["null", null],
    ["array root", []],
    ["bad client scalar", healthDetails("bad")],
    ["bad client null", healthDetails(null)],
    ["bad client array", healthDetails([])],
    ["missing server", { client: validHealthClient, socketReachable: true, compatible: true }],
    ["bad server scalar", healthDetails(validHealthClient, "bad")],
    ["bad server null", healthDetails(validHealthClient, null)],
    ["bad server array", healthDetails(validHealthClient, [])],
    ["empty client version", healthDetails({ version: "", protocol: 19 })],
    ["oversized client version", healthDetails({ version: "v".repeat(MAX_HEALTH_VERSION_LENGTH + 1), protocol: 19 })],
    ["non-string client version", healthDetails({ version: 19, protocol: 19 })],
    ["invalid client protocol type", healthDetails({ version: "0.8.0", protocol: "19" })],
    ["non-finite client protocol", healthDetails({ version: "0.8.0", protocol: Infinity })],
    ["non-integer client protocol", healthDetails({ version: "0.8.0", protocol: 19.5 })],
    ["non-positive client protocol", healthDetails({ version: "0.8.0", protocol: 0 })],
    ["malformed status", healthDetails(validHealthClient, { status: 123, version: "0.8.0", protocol: 19, compatible: true })],
    ["empty status", healthDetails(validHealthClient, { status: "", version: "0.8.0", protocol: 19, compatible: true })],
    ["oversized status", healthDetails(validHealthClient, { status: "s".repeat(MAX_HEALTH_STATUS_LENGTH + 1), version: "0.8.0", protocol: 19, compatible: true })],
    ["empty server version", healthDetails(validHealthClient, { status: "running", version: "", protocol: 19, compatible: true })],
    ["oversized server version", healthDetails(validHealthClient, { status: "running", version: "v".repeat(MAX_HEALTH_VERSION_LENGTH + 1), protocol: 19, compatible: true })],
    ["non-string server version", healthDetails(validHealthClient, { status: "running", version: 19, protocol: 19, compatible: true })],
    ["invalid server protocol type", healthDetails(validHealthClient, { status: "running", version: "0.8.0", protocol: "19", compatible: true })],
    ["non-finite server protocol", healthDetails(validHealthClient, { status: "running", version: "0.8.0", protocol: Infinity, compatible: true })],
    ["non-integer server protocol", healthDetails(validHealthClient, { status: "running", version: "0.8.0", protocol: 19.5, compatible: true })],
    ["non-positive server protocol", healthDetails(validHealthClient, { status: "running", version: "0.8.0", protocol: 0, compatible: true })],
    ["malformed compatible", healthDetails(validHealthClient, { status: "running", version: "0.8.0", protocol: 19, compatible: "true" }, { compatible: "true" })],
    ["missing socket reachability", { client: validHealthClient, server: validHealthServer, compatible: true }]
  ] as const;
  const mappedMalformedHealthCases = malformedHealthCases.flatMap(([name, health]) => (["CLI_INCOMPATIBLE", "BACKEND_UNAVAILABLE"] as const).map((code) => [name, code, health] as const));

  it.each(mappedMalformedHealthCases)("drops %s health details from %s preflight errors", (_name, code, health) => {
    const mapped = mapPreflightFailure(new CliProtocolError(code, "preflight failed", { health }));
    expect(mapped).toMatchObject({ code });
    expect(mapped.details).not.toHaveProperty("health");
  });

  const completeTypedHealth = healthDetails(validHealthClient, { ...validHealthServer, compatible: true });
  const completeSafeHealth = { client: validHealthClient, server: validHealthServer, socketReachable: true, compatible: true };
  const degradedTypedHealth = { client: validHealthClient, server: { status: "stopped" }, socketReachable: false };
  const retainedHealthCases = [
    ["complete", completeTypedHealth, completeSafeHealth],
    ["degraded", degradedTypedHealth, degradedTypedHealth]
  ] as const;
  it.each(retainedHealthCases.flatMap(([name, health, expected]) => (["CLI_INCOMPATIBLE", "BACKEND_UNAVAILABLE"] as const).map((code) => [name, code, health, expected] as const)))("retains %s safe typed health details for %s preflight errors", (_name, code, health, expected) => {
    const mapped = mapPreflightFailure(new CliProtocolError(code, "preflight failed", { health }));
    expect(mapped.details.health).toEqual(expected);
  });

  it("fails closed for contradictory running protocol metadata before dispatching a mutation", async () => {
    const output = JSON.stringify({ client: { version: "0.8.0", protocol: 19 }, server: { status: "running", version: "0.8.0", protocol: 18, compatible: true } });
    const { promise, calls } = productionRename(output);
    const error = await promise.catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "CLI_INCOMPATIBLE", details: { health: { client: { protocol: 19 }, server: { protocol: 18 }, compatible: true } } });
    expect(calls).toEqual([["status", "--json"]]);
  });

  it("keeps equal protocols compatible and mismatch with false unchanged", async () => {
    await expect(preflightCompatibility({ runText: vi.fn(async () => healthy) }, new AbortController().signal)).resolves.toMatchObject({ client: { protocol: 19 }, server: { protocol: 19 } });
    const mismatch = JSON.stringify({ client: { version: "0.8.0", protocol: 19 }, server: { status: "running", version: "0.7.0", protocol: 18, compatible: false } });
    await expect(preflightCompatibility({ runText: vi.fn(async () => mismatch) }, new AbortController().signal)).rejects.toMatchObject({ code: "CLI_INCOMPATIBLE" });
  });

  it("preserves an abort that happens before compatibility preflight without dispatching a mutation", async () => {
    const controller = new AbortController();
    controller.abort();
    const exec = vi.fn<PiExec>();
    const cli = new HerdrCli(exec);
    const tool = createPaneTool({ cli, context, preflight: async (signal) => { await preflightCompatibility(cli, signal); } });

    await expect(tool.execute("id", { operation: "rename", target: "p1", label: "new" } as never, controller.signal, undefined, { cwd: "/repo", signal: controller.signal } as never))
      .rejects.toMatchObject({ code: "ABORTED" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("preserves an abort during compatibility preflight without dispatching a mutation", async () => {
    const controller = new AbortController();
    const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      expect(argv).toEqual(["status", "--json"]);
      controller.abort();
      return { stdout: healthy, stderr: "", code: 0, killed: false };
    });
    const cli = new HerdrCli(exec);
    const tool = createPaneTool({ cli, context, preflight: async (signal) => { await preflightCompatibility(cli, signal); } });

    await expect(tool.execute("id", { operation: "rename", target: "p1", label: "new" } as never, controller.signal, undefined, { cwd: "/repo", signal: controller.signal } as never))
      .rejects.toMatchObject({ code: "ABORTED" });
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls.every(([, argv]) => argv[0] === "status")).toBe(true);
  });

  it.each([
    ["array root", "[]", "CLI_INCOMPATIBLE"],
    ["malformed health", "not-json", "CLI_INCOMPATIBLE"],
    ["array fields", JSON.stringify({ client: [], server: {} }), "CLI_INCOMPATIBLE"],
    ["missing fields", JSON.stringify({ client: {}, server: {} }), "CLI_INCOMPATIBLE"],
    ["incompatible versions", JSON.stringify({ client: { version: "0.8.0", protocol: 19 }, server: { status: "running", version: "0.7.0", protocol: 18, compatible: false } }), "CLI_INCOMPATIBLE"],
    ["stopped backend", JSON.stringify({ client: { version: "0.8.0", protocol: 19 }, server: { status: "stopped", version: "0.8.0", protocol: 19, compatible: true } }), "BACKEND_UNAVAILABLE"]
  ] as const)("returns a typed %s preflight failure", async (_name, output, code) => {
    const cli = { runText: vi.fn(async () => output) };
    await expect(preflightCompatibility(cli, new AbortController().signal)).rejects.toMatchObject({ code });
  });

  it("maps unknown and missing-CLI errors directly", () => {
    expect(mapPreflightFailure({ code: "unexpected" })).toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    expect(mapPreflightFailure(new CliProtocolError("CLI_NOT_FOUND", "missing"))).toMatchObject({ code: "CLI_INCOMPATIBLE" });
  });

  it.each([
    ["CLI_NOT_FOUND", new CliProtocolError("CLI_NOT_FOUND", "missing"), "CLI_INCOMPATIBLE"],
    ["CLI_TIMEOUT", new CliProtocolError("CLI_TIMEOUT", "timed out"), "BACKEND_UNAVAILABLE"],
    ["protocol with successful process", new CliProtocolError("CLI_PROTOCOL_ERROR", "bad output", { exitCode: 0 }), "CLI_INCOMPATIBLE"],
    ["protocol with failed process", new CliProtocolError("CLI_PROTOCOL_ERROR", "backend failed", { exitCode: 1 }), "BACKEND_UNAVAILABLE"],
    ["unknown failure", new Error("backend down"), "BACKEND_UNAVAILABLE"],
    ["preserved incompatible", new CliProtocolError("CLI_INCOMPATIBLE", "incompatible"), "CLI_INCOMPATIBLE"],
    ["preserved backend", new CliProtocolError("BACKEND_UNAVAILABLE", "unavailable"), "BACKEND_UNAVAILABLE"]
  ] as const)("maps %s to %s", async (_name, failure, code) => {
    const cli = { runText: vi.fn(async () => { throw failure; }) };
    await expect(preflightCompatibility(cli, new AbortController().signal)).rejects.toMatchObject({ code });
  });

  it("blocks pane mutations before any CLI mutation call", async () => {
    const runJson = vi.fn();
    const preflight = vi.fn(async () => { throw new CliProtocolError("BACKEND_UNAVAILABLE", "backend unavailable"); });
    const tool = createPaneTool({ cli: { runJson } as never, context, preflight });
    await expect(tool.execute("id", { operation: "rename", target: "p1", label: "new" } as never, new AbortController().signal, undefined, { cwd: "/repo", signal: new AbortController().signal } as never)).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    expect(preflight).toHaveBeenCalledOnce();
    expect(runJson).not.toHaveBeenCalled();
  });
});
