import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeQuotaSignal } from "../../src/supervision/claude-quota.js";

// Redacted projection of a Claude Code 2.1.281 Fable quota record observed on 2026-09-24.
// Session ID, cwd, request ID and timestamp were replaced; no transcript content was copied.
const nativeProjection = new URL("./fixtures/claude-quota-native-projection.jsonl", import.meta.url);
const uuid = "00000000-0000-4000-8000-000000000001";
const session = { source: "herdr:claude", agent: "claude", kind: "id", value: uuid };
const cwd = "/home/worker/project";
const before = Date.parse("2026-09-24T12:00:00.000Z");
const record = (fields: Record<string, unknown> = {}) => ({ type: "assistant", sessionId: uuid, cwd,
  isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429, requestId: "req-1", timestamp: new Date().toISOString(), ...fields });
/** The initial prompt turn — a user record carrying no tool results. */
const prompt = () => ({ type: "user", sessionId: uuid, cwd, timestamp: new Date().toISOString(), message: { role: "user", content: "run the task" } });
let home: string;
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); });

async function put(rows: object[]): Promise<string> {
  const projects = join(home, ".claude", "projects");
  const directory = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${uuid}.jsonl`);
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  return path;
}

it("requires exact Claude session, cwd, typed assistant quota and trusted native file", async () => {
  home = await mkdtemp(join(tmpdir(), "claude-quota-"));
  const path = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${uuid}.jsonl`);
  const rewrite = (...rows: object[]) => writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  await mkdir(join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true, mode: 0o700 });
  await rewrite(record({ sessionId: "another-session" }), record({ cwd: "/other/project" }), record({ error: "auth" }), record({ isApiErrorMessage: false }), record({ apiErrorStatus: 500 }), record({ timestamp: new Date(before - 1000).toISOString() }));
  expect(await claudeQuotaSignal(session, cwd, before, home)).toBe(false);
  await rewrite(record({ error: "429" }), JSON.parse(await readFile(nativeProjection, "utf8")));
  expect(await claudeQuotaSignal(session, cwd, before, home)).toEqual({ retryNotBefore: null, zeroProgressProven: true });
  expect(await claudeQuotaSignal({ ...session, source: "foreign" }, cwd, before, home)).toBe(false);
  expect(await claudeQuotaSignal({ ...session, value: "695bc6bc-a5da-4b30-9f00-ca2a6e67c64c" }, cwd, before, home)).toBe(false);
  await rm(path);
  await symlink(join(home, ".claude", "projects", "missing"), path);
  expect(await claudeQuotaSignal(session, cwd, before, home)).toBe(false);
});

it("refuses untrusted .claude directory components and non-file records", async () => {
  home = await mkdtemp(join(tmpdir(), "claude-quota-"));
  const projects = join(home, ".claude", "projects");
  const directory = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));

  // `.claude` is a regular file, not a directory.
  await writeFile(join(home, ".claude"), "", { mode: 0o600 });
  expect(await claudeQuotaSignal(session, cwd, before, home)).toBe(false);
  await rm(join(home, ".claude"));

  // A group-readable directory component fails the owner-only trust check.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(join(home, ".claude"), 0o750);
  expect(await claudeQuotaSignal(session, cwd, before, home)).toBe(false);
  await chmod(join(home, ".claude"), 0o700);

  // The session record exists but is a directory, not a file.
  await mkdir(join(directory, `${uuid}.jsonl`));
  expect(await claudeQuotaSignal(session, cwd, before, home)).toBe(false);
});

it("skips malformed, non-object, and partial-tail lines before the matching record", async () => {
  home = await mkdtemp(join(tmpdir(), "claude-quota-"));
  const path = await put([]);
  // `null`, an array, a bare string, and an unparseable fragment are all skipped;
  // the unterminated final line is dropped as a writer's partial record.
  const content = `null\n[1,2]\n"plain"\n{bad json\n${JSON.stringify(record({ timestamp: "not-a-date" }))}\n${JSON.stringify(record())}`;
  await writeFile(path, content, { mode: 0o600 });
  expect(await claudeQuotaSignal(session, cwd, before, home)).toBe(false);
  // The same content properly terminated matches. The session record whose
  // timestamp cannot be ordered against the prompt defeats the zero-progress
  // proof — an in-window record must classify, never be assumed benign.
  await writeFile(path, `${content}\n`, { mode: 0o600 });
  expect(await claudeQuotaSignal(session, cwd, before, home)).toEqual({ retryNotBefore: null, zeroProgressProven: false });
});

it("reads only the file tail, dropping the leading partial line of an oversized record", async () => {
  home = await mkdtemp(join(tmpdir(), "claude-quota-"));
  const path = await put([]);
  // Over 512 KiB of filler pushes the read window inside the file: the first
  // scanned line is partial and skipped, and the matching record still lands.
  // The tail never reaches back past the prompt, so zero progress is unprovable.
  const filler = `${"x".repeat(600)}\n`.repeat(900);
  const content = `${JSON.stringify(record({ sessionId: "early-session" }))}\n${filler}${JSON.stringify(record())}\n`;
  await writeFile(path, content, { mode: 0o600 });
  expect(content.length).toBeGreaterThan(512 * 1024);
  expect(await claudeQuotaSignal(session, cwd, before, home)).toEqual({ retryNotBefore: null, zeroProgressProven: false });
});

describe("provider reset evidence", () => {
  const limitAt = (iso: string) => record({ timestamp: iso });
  const base = "2026-09-24T12:00:01.000Z";

  it("records the provider's own reset instant from a typed field, never a guess", async () => {
    home = await mkdtemp(join(tmpdir(), "claude-quota-"));
    const resetMs = Date.parse("2026-09-24T12:45:00.000Z");
    await put([prompt(), limitAt(base)]);
    expect(await claudeQuotaSignal(session, cwd, before, home)).toEqual({ retryNotBefore: null, zeroProgressProven: true });
    for (const [fields, expected] of [
      [{ resetAt: "2026-09-24T12:45:00.000Z" }, "2026-09-24T12:45:00.000Z"],
      [{ retryNotBefore: "2026-09-24T12:45:00.000Z" }, "2026-09-24T12:45:00.000Z"],
      [{ resetsAt: resetMs }, new Date(resetMs).toISOString()],
      [{ retry_at: Math.floor(resetMs / 1000) }, new Date(resetMs).toISOString()],
      [{ retryAfterSeconds: 120 }, new Date(Date.parse(base) + 120_000).toISOString()],
      [{ retry_after: 120 }, new Date(Date.parse(base) + 120_000).toISOString()],
      [{ retryAfterMs: 30_000 }, new Date(Date.parse(base) + 30_000).toISOString()],
      [{ message: { content: [{ type: "text", text: `Claude AI usage limit reached|${Math.floor(resetMs / 1000)}` }] } }, new Date(resetMs).toISOString()],
      [{ message: `Claude AI usage limit reached|${resetMs}` }, new Date(resetMs).toISOString()],
      // Non-text content blocks are skipped; a later text block still carries the signal.
      [{ message: { content: [null, "plain text", { type: "text", text: `usage limit reached|${Math.floor(resetMs / 1000)}` }] } }, new Date(resetMs).toISOString()],
    ] as const) {
      await put([prompt(), limitAt(base)]);
      const limited = { ...limitAt(base), ...fields };
      await put([prompt(), limited]);
      expect(await claudeQuotaSignal(session, cwd, before, home)).toEqual({ retryNotBefore: expected, zeroProgressProven: true });
    }
  });

  it("treats contradictory or unparseable reset evidence as no signal", async () => {
    home = await mkdtemp(join(tmpdir(), "claude-quota-"));
    const path = await put([]);
    // A numeric field that overflows to Infinity after JSON parse is not a usable signal.
    await writeFile(path, `${JSON.stringify(prompt())}\n{"type":"assistant","sessionId":"${uuid}","cwd":"${cwd}","isApiErrorMessage":true,"error":"rate_limit","apiErrorStatus":429,"requestId":"req-1","timestamp":"${base}","resetAt":1e400}\n`, { mode: 0o600 });
    expect(await claudeQuotaSignal(session, cwd, before, home)).toEqual({ retryNotBefore: null, zeroProgressProven: true });
    for (const fields of [
      // A reset at or before the failure's own timestamp is contradictory.
      { resetAt: base },
      { resetAt: new Date(Date.parse(base) - 1).toISOString() },
      { resetAt: "not-a-date" },
      { resetAt: Number.NaN },
      { retryAfter: "soon" },
      { retryAfter: 0 },
      { message: { content: [{ type: "text", text: "rate limited, try later" }] } },
      { message: { content: [{ type: "text", text: "usage limit reached|not-a-number" }] } },
      // A reset instant from the distant past contradicts the failure it rides on.
      { message: `Claude AI usage limit reached|1000000000` },
    ]) {
      await put([prompt(), { ...limitAt(base), ...fields }]);
      expect(await claudeQuotaSignal(session, cwd, before, home)).toEqual({ retryNotBefore: null, zeroProgressProven: true });
    }
  });
});

describe("zero-progress proof", () => {
  it("fails closed on any task activity or unprovable window", async () => {
    home = await mkdtemp(join(tmpdir(), "claude-quota-"));
    const priorTurn = { type: "user", sessionId: uuid, cwd, timestamp: new Date(before - 500).toISOString(), message: { role: "user", content: "earlier" } };
    const clean = [prompt(), record()];
    expect(await put(clean)).toBeTruthy();
    expect(await claudeQuotaSignal(session, cwd, before, home)).toEqual({ retryNotBefore: null, zeroProgressProven: true });

    // Junk content blocks on the prompt record carry no tool evidence.
    await put([{ ...prompt(), message: { role: "user", content: ["text", null, { type: 7 }] } }, record()]);
    expect(await claudeQuotaSignal(session, cwd, before, home)).toEqual({ retryNotBefore: null, zeroProgressProven: true });

    const active: Array<{ name: string; rows: object[] }> = [
      // A tool call in the post-prompt window.
      { name: "tool_use", rows: [prompt(), { type: "assistant", sessionId: uuid, cwd, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] } }, record()] },
      // A tool result arriving on a user record.
      { name: "tool_result", rows: [prompt(), { type: "user", sessionId: uuid, cwd, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "tool_result", content: "out" }] } }, record()] },
      { name: "toolUseResult field", rows: [prompt(), { type: "user", sessionId: uuid, cwd, timestamp: new Date().toISOString(), toolUseResult: { stdout: "x" } }, record()] },
      // Ordinary assistant output (non-error) means the child produced work.
      { name: "assistant text", rows: [prompt(), { type: "assistant", sessionId: uuid, cwd, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "working" }] } }, record()] },
      // An api-error assistant record that itself carries a tool call.
      { name: "error with tool_use", rows: [prompt(), { type: "assistant", sessionId: uuid, cwd, timestamp: new Date().toISOString(), isApiErrorMessage: true, error: "overloaded", message: { role: "assistant", content: [{ type: "tool_use" }] } }, record()] },
      // Foreign record types — snapshots, summaries, progress — are not benign.
      { name: "file-history-snapshot", rows: [prompt(), { type: "file-history-snapshot", sessionId: uuid, cwd, timestamp: new Date().toISOString() }, record()] },
      // A session record whose timestamp is not a string cannot be ordered
      // against the prompt, so the window is unprovable.
      { name: "non-string timestamp", rows: [prompt(), { ...record(), timestamp: 7 }, record()] },
    ];
    for (const { rows } of active) {
      await put(rows);
      expect(await claudeQuotaSignal(session, cwd, before, home)).toEqual({ retryNotBefore: null, zeroProgressProven: false });
    }

    // A pre-prompt record proves window coverage even when the tail is not the
    // whole file: here it is simply part of the same small file.
    await put([priorTurn, prompt(), record()]);
    expect(await claudeQuotaSignal(session, cwd, before, home)).toEqual({ retryNotBefore: null, zeroProgressProven: true });
  });
});
