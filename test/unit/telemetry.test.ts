import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SpecLaunchParamsSchema } from "../../src/launch-schema.js";
import {
  TOOL_DIAGNOSTIC_MARKER,
  TOOL_DIAGNOSTIC_MAX_BYTES,
  TOOL_TELEMETRY_MAX_BYTES,
  ToolInputError,
  appendToolTelemetry,
  boundedDiagnosticMessage,
  invalidInputDiagnostic,
  invalidInputError,
  monotonicDurationMs,
  telemetryEffectCertainty,
  telemetryOperation,
  toolTelemetryPaths,
  type ToolTelemetryEntry,
  type ToolTelemetryRecord,
} from "../../src/telemetry.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "herdr-tool-telemetry-"));
  roots.push(value);
  return value;
}

function entry(overrides: Partial<ToolTelemetryEntry> = {}): ToolTelemetryEntry {
  return {
    tool: "herdr_tab",
    operation: "create",
    phases: { validate: "success", execute: "success", persist: "success" },
    durationMs: 7,
    effectCertainty: "confirmed",
    ...overrides,
  };
}

describe("tool schema diagnostics", () => {
  it("reports bounded paths, expected shapes, and received types without raw values", () => {
    const schema = Type.Object({
      count: Type.Number(),
      tags: Type.Array(Type.String()),
      requiredName: Type.String(),
      patterned: Type.String({ pattern: "^[a-z]+$" }),
      positive: Type.Number({ exclusiveMinimum: 0 }),
      short: Type.String({ minLength: 2 }),
    }, { additionalProperties: false });
    const raw = { count: "raw-count-secret", tags: null, patterned: "1", positive: 0, short: "x", extra: "raw-extra-secret" };
    const diagnostic = invalidInputDiagnostic("herdr_tab", schema, raw)!;
    expect(diagnostic).toMatchObject({
      tool: "herdr_tab",
      schema: "herdr_tab",
      code: "INVALID_INPUT",
      phase: "validate",
      errors: expect.arrayContaining([
        { path: "/requiredName", expected: "required property", received: "missing" },
        { path: "/extra", expected: "property not allowed", received: "string" },
        { path: "/count", expected: "type number", received: "string" },
        { path: "/tags", expected: "type array", received: "null" },
        { path: "/patterned", expected: "string matching schema pattern", received: "string" },
        { path: "/positive", expected: "exclusiveMinimum 0", received: "number" },
        { path: "/short", expected: "minLength 2", received: "string" },
      ]) as unknown[],
      effectCertainty: "absent",
    });
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain("raw-count-secret");
    expect(serialized).not.toContain("raw-extra-secret");

    const failure = invalidInputError("herdr_tab", schema, raw)!;
    expect(failure).toBeInstanceOf(ToolInputError);
    expect(failure.message).toContain(TOOL_DIAGNOSTIC_MARKER);
    expect(Buffer.byteLength(failure.message, "utf8")).toBeLessThanOrEqual(TOOL_DIAGNOSTIC_MAX_BYTES);
    expect(invalidInputDiagnostic("herdr_tab", schema, { count: 1, tags: [], requiredName: "ok", patterned: "ok", positive: 1, short: "ok" })).toBeUndefined();
    expect(invalidInputDiagnostic("herdr_tab", Type.Union([Type.Literal("x"), Type.Literal("y")]), "z")!.errors)
      .toContainEqual({ path: "/", expected: "matching schema variant", received: "string" });

    const duplicateLabel = "private";
    const refined = invalidInputDiagnostic("herdr_launch", SpecLaunchParamsSchema, {
      name: "task",
      specs: Array.from({ length: 2 }, () => ({ label: duplicateLabel, instructions: "i", assignment: { objective: "o", scope: "s", verification: "v" } })),
      supervisionDigest: { doneWhen: ["done"], constraints: ["none"] },
    })!;
    expect(refined.errors).toContainEqual({ path: "/specs", expected: "custom schema constraint", received: "array" });
    expect(JSON.stringify(refined)).not.toContain(duplicateLabel);
  });

  it("caps error count and falls back to marker-only valid JSON when a payload cannot fit", () => {
    const schema = Type.Object({}, { additionalProperties: false });
    const diagnostic = invalidInputDiagnostic("bad tool name", schema, Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field-${index}-${"x".repeat(300)}`, index])))!;
    expect(diagnostic.tool).toBe("herdr_tool");
    expect(diagnostic.errors).toHaveLength(8);
    expect(diagnostic.errors.every((error) => Buffer.byteLength(error.path, "utf8") <= 256)).toBe(true);

    const fallback = { code: "FALLBACK" };
    const message = boundedDiagnosticMessage("summary", "MARKER", { body: "x".repeat(100) }, 20, fallback);
    expect(message).toBe(`MARKER ${JSON.stringify(fallback)}`);
    expect(boundedDiagnosticMessage("sum\nmary", "MARKER", { ok: true }, 100, fallback)).toBe('sum mary\nMARKER {"ok":true}');
  });
});

describe("tool operation telemetry", () => {
  it("appends one allowlisted bounded 0600 record and drops stray fields", async () => {
    const project = await root();
    const dirty = { ...entry(), rawArgs: { token: "raw-secret" }, transcript: "raw-transcript" } as ToolTelemetryEntry;
    await appendToolTelemetry(dirty, { root: project, now: () => new Date("2026-09-20T10:00:00.000Z"), waitMs: 1_000 });
    await appendToolTelemetry(entry({ operation: "close", phases: { validate: "success", execute: "failure", persist: "success" }, effectCertainty: "unknown" }), { root: project, deadlineMs: 10_000 });

    const paths = toolTelemetryPaths(project);
    const content = await readFile(paths.records, "utf8");
    const lines = content.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => Buffer.byteLength(`${line}\n`, "utf8") <= TOOL_TELEMETRY_MAX_BYTES)).toBe(true);
    const record = JSON.parse(lines[0]!) as ToolTelemetryRecord;
    expect(record).toEqual({
      timestamp: "2026-09-20T10:00:00.000Z",
      tool: "herdr_tab",
      operation: "create",
      phases: { validate: "success", execute: "success", persist: "success" },
      durationMs: 7,
      effectCertainty: "confirmed",
    });
    expect(content).not.toContain("raw-secret");
    expect(content).not.toContain("raw-transcript");
    expect((await lstat(paths.records)).mode & 0o777).toBe(0o600);
  });

  it("degrades silently for invalid records, roots, and untrusted persistence paths", async () => {
    await expect(appendToolTelemetry(entry(), { root: "relative" })).resolves.toBeUndefined();
    const invalidRoot = await root();
    const invalidEntries: ToolTelemetryEntry[] = [
      entry({ operation: "raw-secret-operation" }),
      entry({ tool: "herdr_unknown" }),
      entry({ phases: { validate: "bad" as never, execute: "success", persist: "success" } }),
      entry({ durationMs: -1 }),
      entry({ effectCertainty: "bad" as never }),
    ];
    for (const invalid of invalidEntries) await expect(appendToolTelemetry(invalid, { root: invalidRoot })).resolves.toBeUndefined();
    await expect(readFile(toolTelemetryPaths(invalidRoot).records, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const project = await root();
    await appendToolTelemetry(entry(), { root: project });
    const paths = toolTelemetryPaths(project);
    await chmod(paths.records, 0o666);
    await expect(appendToolTelemetry(entry(), { root: project })).resolves.toBeUndefined();
    expect((await readFile(paths.records, "utf8")).trimEnd().split("\n")).toHaveLength(1);
  });

  it("derives only closed operations, durations, and effect certainties", () => {
    expect(telemetryOperation("herdr_inspect", {}, true)).toBe("context");
    expect(telemetryOperation("herdr_inspect", { mode: "health" }, true)).toBe("health");
    expect(telemetryOperation("herdr_wait", {}, true)).toBe("wait");
    expect(telemetryOperation("herdr_launch", {}, true)).toBe("launch");
    expect(telemetryOperation("herdr_tab", { operation: "close" }, true)).toBe("close");
    expect(telemetryOperation("herdr_tab", { operation: "raw-secret" }, true)).toBe("unknown");
    expect(telemetryOperation("herdr_tab", null, true)).toBe("unknown");
    expect(telemetryOperation("herdr_tab", { operation: "close" }, false)).toBe("invalid");
    expect(monotonicDurationMs(10, 10)).toBe(0);
    expect(monotonicDurationMs(10, 10.1)).toBe(1);
    expect(monotonicDurationMs(0, Number.MAX_SAFE_INTEGER + 10)).toBe(Number.MAX_SAFE_INTEGER);
    expect(monotonicDurationMs(0, Number.POSITIVE_INFINITY)).toBe(0);
    expect(telemetryEffectCertainty({ details: { effectCertainty: "partial" } }, "unknown")).toBe("partial");
    expect(telemetryEffectCertainty({ effectCertainty: "absent" }, "unknown")).toBe("absent");
    expect(telemetryEffectCertainty({ details: { effectCertainty: "raw-secret" } }, "confirmed")).toBe("confirmed");
    expect(telemetryEffectCertainty(null, "unknown")).toBe("unknown");
  });
});
