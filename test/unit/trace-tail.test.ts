/**
 * The ADR-040 amendment tail scan (plan rev4 node D): the per-kind user-turn
 * tables of §2, the single slack-boundary rule (F14), the history-fingerprint
 * rollback proof (F15), pending tails, inversions, and the capture that mints
 * the fingerprint. Real files under a 0700 tmpdir; every fixture is redacted
 * (synthetic ids, no bodies).
 */
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HandoffTraceHistory } from "../../src/handoff.js";
import type { AgentSessionIdentity } from "../../src/messages/prompt.js";
import { openTrustedTraceFile } from "../../src/supervision/trace-file.js";
import {
  captureTraceHistory,
  tailScan,
  TRACE_HISTORY_ANCHOR_BYTES,
  TRACE_TAIL_BUDGET_BYTES,
  TRACE_TAIL_SLACK_MS,
  type TailScan,
  type TraceTailDeps,
  type TraceTailTarget,
} from "../../src/supervision/trace-tail.js";

const ANCHOR = Date.parse("2026-10-01T12:00:00.000Z");
const at = (deltaMs: number): string => new Date(ANCHOR + deltaMs).toISOString();
const UUID = "00000000-0000-4000-8000-000000000001";
const CWD = "/project";
const piSession: AgentSessionIdentity = { source: "herdr:pi", agent: "pi", kind: "path", value: "/pi/session.jsonl" };
const claudeSession: AgentSessionIdentity = { source: "herdr:claude", agent: "claude", kind: "id", value: UUID };
const devinSession: AgentSessionIdentity = { source: "herdr:devin", agent: "devin", kind: "id", value: "sess-1" };
const signal = () => new AbortController().signal;
const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-trace-tail-"));
  await chmod(dir, 0o700);
  dirs.push(dir);
  return dir;
}

const depsFor = (dir: string, over: Partial<TraceTailDeps> = {}): TraceTailDeps => ({ rootDir: dir, home: dir, devinTranscriptsDir: join(dir, "devin"), ...over });
const piPath = (dir: string) => join(dir, piSession.value);
const claudePath = (dir: string) => join(dir, ".claude", "projects", CWD.replace(/[^a-zA-Z0-9]/g, "-"), `${UUID}.jsonl`);
const devinPath = (dir: string, id = devinSession.value) => join(dir, "devin", `${id}.json`);

async function writeJsonl(path: string, records: unknown[], pendingTail = ""): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}${records.length === 0 ? "" : "\n"}${pendingTail}`, { mode: 0o600 });
}

async function writeDoc(path: string, document: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(document), { mode: 0o600 });
}

const PI: TraceTailTarget = { agentKind: "pi", session: piSession };
const CLAUDE: TraceTailTarget = { agentKind: "claude", session: claudeSession, workspace: { resolvedCwd: CWD } };
const DEVIN: TraceTailTarget = { agentKind: "devin", session: devinSession };

/** Redacted record builders — shapes only. */
const pi = {
  message: (role: string, deltaMs?: number, over: Record<string, unknown> = {}) =>
    ({ type: "message", id: "m", ...(deltaMs === undefined ? {} : { timestamp: at(deltaMs) }), message: { role, content: "redacted" }, ...over }),
  state: (type: string, deltaMs: number) => ({ type, id: "s", timestamp: at(deltaMs) }),
};
const claude = (type: string, deltaMs: number | undefined, over: Record<string, unknown> = {}) => ({
  type,
  sessionId: UUID,
  cwd: CWD,
  ...(deltaMs === undefined ? {} : { timestamp: at(deltaMs) }),
  ...(type === "user" || type === "assistant" ? { message: { role: type, content: "redacted" } } : {}),
  ...over,
});
const devinDoc = (steps: Array<Record<string, unknown>>, sessionId = devinSession.value) => ({
  schema_version: "ATIF-v1.7",
  session_id: sessionId,
  steps: steps.map((step, index) => ({ step_id: index + 1, message: "redacted", ...step })),
});
const step = (source: string, deltaMs?: number, over: Record<string, unknown> = {}) =>
  ({ source, ...(deltaMs === undefined ? {} : { timestamp: at(deltaMs) }), ...over });

/** Quiet prefixes: every record older than the slack boundary. */
const OLD = -TRACE_TAIL_SLACK_MS - 60_000;
const PI_QUIET = [pi.state("session", OLD), pi.message("user", OLD + 1_000), pi.message("assistant", OLD + 2_000)];
const CLAUDE_QUIET = [claude("user", OLD), claude("assistant", OLD + 1_000)];
const DEVIN_QUIET = [step("system", OLD), step("user", OLD + 1_000), step("agent", OLD + 2_000)];

async function capture(target: TraceTailTarget, deps: TraceTailDeps): Promise<HandoffTraceHistory> {
  const history = await captureTraceHistory({ agentKind: target.agentKind, agentSession: target.session }, target.workspace, signal(), deps);
  if (history === undefined) throw new Error("capture failed");
  return history;
}

/** Seed `records`, capture the fingerprint, then apply `then` and scan. */
async function scanAfter(target: TraceTailTarget, dir: string, seed: () => Promise<void>, then: () => Promise<void> = async () => undefined, anchorMs = ANCHOR): Promise<TailScan> {
  await seed();
  const history = await capture(target, depsFor(dir));
  await then();
  return tailScan(target, anchorMs, history, depsFor(dir));
}

describe("tail scan: Claude user-turn table (§2.1)", () => {
  const cases: Array<{ name: string; record: Record<string, unknown>; kind: TailScan["kind"]; reason?: string }> = [
    { name: "a prompt submitted to the agent (string content)", record: claude("user", 1_000), kind: "user_turn" },
    { name: "an interruption (text block content)", record: claude("user", 1_000, { message: { role: "user", content: [{ type: "text", text: "redacted" }] } }), kind: "user_turn" },
    { name: "tool output (toolUseResult)", record: claude("user", 1_000, { toolUseResult: {}, sourceToolAssistantUUID: "x" }), kind: "none" },
    { name: "tool output (tool_result block)", record: claude("user", 1_000, { message: { role: "user", content: [{ type: "tool_result", content: "redacted" }] } }), kind: "none" },
    { name: "runtime-injected context (isMeta)", record: claude("user", 1_000, { isMeta: true }), kind: "none" },
    { name: "a compaction summary", record: claude("user", 1_000, { isCompactSummary: true }), kind: "none" },
    { name: "a sidechain record", record: claude("user", 1_000, { isSidechain: true }), kind: "none" },
    { name: "an empty-content user record", record: claude("user", 1_000, { message: { role: "user", content: "" } }), kind: "none" },
    { name: "a non-user role under type user", record: claude("user", 1_000, { message: { role: "assistant", content: "redacted" } }), kind: "none" },
    { name: "assistant output", record: claude("assistant", 1_000), kind: "none" },
    { name: "a non-user record without a timestamp (tolerated)", record: claude("file-history-snapshot", undefined), kind: "none" },
    { name: "a user turn without a timestamp", record: claude("user", undefined), kind: "ambiguous", reason: "timestamp_missing" },
    { name: "a user turn with an unparseable timestamp", record: claude("user", undefined, { timestamp: "yesterday" }), kind: "ambiguous", reason: "timestamp_missing" },
    { name: "a record of another session inside the tail", record: claude("assistant", -1_000, { sessionId: "00000000-0000-4000-8000-000000000002" }), kind: "ambiguous", reason: "session_drift" },
    { name: "a user turn exactly at the anchor (equal counts)", record: claude("user", 0), kind: "user_turn" },
    { name: "a user turn 1 ms before the anchor", record: claude("user", -1), kind: "none" },
  ];
  it.each(cases)("$name → $kind", async ({ record, kind, reason }) => {
    const dir = await root();
    const scan = await scanAfter(CLAUDE, dir, () => writeJsonl(claudePath(dir), CLAUDE_QUIET), () => appendFile(claudePath(dir), `${JSON.stringify(record)}\n`));
    expect(scan).toMatchObject(reason === undefined ? { kind } : { kind, reason });
  });
});

describe("tail scan: Pi user-turn table (§2.2)", () => {
  const cases: Array<{ name: string; record: Record<string, unknown>; kind: TailScan["kind"]; reason?: string }> = [
    { name: "a user message with an entry timestamp", record: pi.message("user", 1_000), kind: "user_turn" },
    { name: "a user message timed only by message.timestamp (epoch ms)", record: pi.message("user", undefined, { message: { role: "user", content: "r", timestamp: ANCHOR + 5 } }), kind: "user_turn" },
    { name: "a user message with neither timestamp", record: pi.message("user"), kind: "ambiguous", reason: "timestamp_missing" },
    { name: "a toolResult message", record: pi.message("toolResult", 1_000), kind: "none" },
    { name: "an assistant message", record: pi.message("assistant", 1_000), kind: "none" },
    { name: "a state record (model_change)", record: pi.state("model_change", 1_000), kind: "none" },
    { name: "a hook-injected custom_message", record: { type: "custom_message", id: "c", timestamp: at(1_000), customType: "x", content: "r", display: false, fromHook: true }, kind: "none" },
    { name: "a custom_message of unknown origin", record: { type: "custom_message", id: "c", timestamp: at(1_000), customType: "x", content: "r", display: false }, kind: "user_turn" },
    { name: "a compaction at or after the anchor", record: { type: "compaction", id: "c", timestamp: at(0), summary: "r", firstKeptEntryId: "m", tokensBefore: 1 }, kind: "ambiguous", reason: "compaction" },
    { name: "a compaction without a timestamp", record: { type: "compaction", id: "c", summary: "r", firstKeptEntryId: "m", tokensBefore: 1 }, kind: "ambiguous", reason: "compaction" },
    { name: "a compaction before the anchor", record: { type: "compaction", id: "c", timestamp: at(-1_000), summary: "r", firstKeptEntryId: "m", tokensBefore: 1 }, kind: "none" },
    { name: "a user message exactly at the anchor", record: pi.message("user", 0), kind: "user_turn" },
  ];
  it.each(cases)("$name → $kind", async ({ record, kind, reason }) => {
    const dir = await root();
    const scan = await scanAfter(PI, dir, () => writeJsonl(piPath(dir), PI_QUIET), () => appendFile(piPath(dir), `${JSON.stringify(record)}\n`));
    expect(scan).toMatchObject(reason === undefined ? { kind } : { kind, reason });
  });
});

describe("tail scan: Devin user-turn table (§2.3)", () => {
  const cases: Array<{ name: string; step: Record<string, unknown>; kind: TailScan["kind"]; reason?: string; failure?: string }> = [
    { name: "a user step after the anchor", step: step("user", 1_000), kind: "user_turn" },
    { name: "a user step at nanosecond precision truncated to the anchor ms", step: step("user", undefined, { timestamp: "2026-10-01T12:00:00.000000999+00:00" }), kind: "user_turn" },
    { name: "an agent step", step: step("agent", 1_000), kind: "none" },
    { name: "a system step (the repair prompt is a user step, not this)", step: step("system", 1_000), kind: "none" },
    { name: "a user step without a timestamp", step: step("user"), kind: "ambiguous", reason: "timestamp_missing" },
    { name: "an unknown source", step: step("tool", 1_000), kind: "failure", failure: "source_malformed" },
  ];
  it.each(cases)("$name → $kind", async ({ step: appended, kind, reason, failure }) => {
    const dir = await root();
    const scan = await scanAfter(DEVIN, dir, () => writeDoc(devinPath(dir), devinDoc(DEVIN_QUIET)), () => writeDoc(devinPath(dir), devinDoc([...DEVIN_QUIET, appended])));
    expect(scan).toMatchObject({ kind, ...(reason === undefined ? {} : { reason }), ...(failure === undefined ? {} : { failure }) });
  });

  it("the whole document is read once, so none needs no slack boundary", async () => {
    const dir = await root();
    let opens = 0;
    const deps = depsFor(dir, { openFile: async (path, options) => { opens += 1; return openTrustedTraceFile(path, options); } });
    await writeDoc(devinPath(dir), devinDoc(DEVIN_QUIET));
    const history = await capture(DEVIN, deps);
    opens = 0;
    // Every step newer than anchor − slack, none a user turn: proven quiet.
    await writeDoc(devinPath(dir), devinDoc([step("system", -1_000), step("agent", -500), step("agent", 2_000)]));
    expect(await tailScan(DEVIN, ANCHOR, { ...history, position: { session: devinSession.value, steps: 0, anchor: sha256("") } }, deps)).toEqual({ kind: "none" });
    expect(opens).toBe(1);
  });

  it("fails closed on a document for another session, a malformed step, and an over-budget document", async () => {
    const dir = await root();
    await writeDoc(devinPath(dir), devinDoc(DEVIN_QUIET));
    const history = await capture(DEVIN, depsFor(dir));
    await writeDoc(devinPath(dir), devinDoc(DEVIN_QUIET, "sess-2"));
    expect(await tailScan(DEVIN, ANCHOR, history, depsFor(dir))).toMatchObject({ kind: "failure", failure: "source_malformed", reason: "session_id_mismatch" });
    await writeDoc(devinPath(dir), { ...devinDoc(DEVIN_QUIET), steps: [...devinDoc(DEVIN_QUIET).steps, { step_id: 9, source: "agent" }] });
    expect(await tailScan(DEVIN, ANCHOR, history, depsFor(dir))).toMatchObject({ kind: "failure", failure: "source_malformed", reason: "step_id_mismatch" });
    await writeFile(devinPath(dir), Buffer.alloc(TRACE_TAIL_BUDGET_BYTES + 1, 0x20), { mode: 0o600 });
    expect(await tailScan(DEVIN, ANCHOR, history, depsFor(dir))).toMatchObject({ kind: "failure", failure: "source_exceeds_budget" });
    await writeFile(devinPath(dir), "{not json", { mode: 0o600 });
    expect(await tailScan(DEVIN, ANCHOR, history, depsFor(dir))).toMatchObject({ kind: "failure", failure: "source_malformed", reason: "invalid_json" });
  });

  it("F15: a truncated or prefix-rewritten document is a rollback", async () => {
    const dir = await root();
    await writeDoc(devinPath(dir), devinDoc(DEVIN_QUIET));
    const history = await capture(DEVIN, depsFor(dir));
    expect(history.position).toMatchObject({ session: devinSession.value, steps: 3 });
    await writeDoc(devinPath(dir), devinDoc(DEVIN_QUIET.slice(0, 2)));
    expect(await tailScan(DEVIN, ANCHOR, history, depsFor(dir))).toMatchObject({ kind: "failure", failure: "source_rewritten", reason: "steps_truncated" });
    // Same length, different prefix content.
    await writeDoc(devinPath(dir), devinDoc([step("system", OLD), step("agent", OLD + 1_000), step("agent", OLD + 2_000)]));
    expect(await tailScan(DEVIN, ANCHOR, history, depsFor(dir))).toMatchObject({ kind: "failure", failure: "source_rewritten", reason: "anchor_mismatch" });
  });
});

describe("tail scan: JSONL tail discipline", () => {
  it("an unterminated record at EOF is a pending tail — missing newline and a split UTF-8 sequence alike", async () => {
    const dir = await root();
    expect(await scanAfter(PI, dir, () => writeJsonl(piPath(dir), PI_QUIET), () => appendFile(piPath(dir), '{"type":"message","message":{"role":"user"'))).toEqual({ kind: "pending_tail" });
    const dir2 = await root();
    expect(await scanAfter(PI, dir2, () => writeJsonl(piPath(dir2), PI_QUIET), () => appendFile(piPath(dir2), Buffer.from([0x7b, 0x22, 0xe2, 0x82])))).toEqual({ kind: "pending_tail" });
  });

  it("a complete line that is not UTF-8, not JSON, or not a typed object is malformed", async () => {
    for (const bad of [Buffer.from([0x7b, 0xff, 0x7d, 0x0a]), Buffer.from("{nope}\n"), Buffer.from("[1]\n"), Buffer.from('{"id":"x"}\n')]) {
      const dir = await root();
      const scan = await scanAfter(PI, dir, () => writeJsonl(piPath(dir), PI_QUIET), () => appendFile(piPath(dir), bad));
      expect(scan).toMatchObject({ kind: "failure", failure: "source_malformed" });
      expect(JSON.stringify(scan)).not.toContain(dir);
    }
  });

  it("an inversion inside the window never hides a follow-up: a non-user record 90 s older appended after a newer user turn", async () => {
    const dir = await root();
    const scan = await scanAfter(PI, dir, () => writeJsonl(piPath(dir), PI_QUIET), () => appendFile(piPath(dir), `${JSON.stringify(pi.message("user", 1_000))}\n${JSON.stringify(pi.message("assistant", -89_000))}\n`));
    expect(scan).toMatchObject({ kind: "user_turn", atMs: ANCHOR + 1_000 });
  });

  it("a whole-file scan (start === 0) returns none without reaching the slack boundary", async () => {
    const dir = await root();
    const scan = await scanAfter(PI, dir, () => writeJsonl(piPath(dir), [pi.message("assistant", -1_000), pi.state("model_change", 2_000)]));
    expect(scan).toEqual({ kind: "none" });
  });

  it("an empty trace is a whole-file scan of nothing", async () => {
    const dir = await root();
    expect(await scanAfter(PI, dir, () => writeJsonl(piPath(dir), []))).toEqual({ kind: "none" });
  });

  describe("F14: a tail read from start > 0", () => {
    /** ~1 KiB non-user filler records, enough to push the file past the budget. */
    const filler = (deltaMs: number): string => `${JSON.stringify(pi.message("assistant", deltaMs, { message: { role: "assistant", content: "x".repeat(1_000) } }))}\n`;
    async function oversized(dir: string, head: unknown[], fillerDeltaMs: number): Promise<HandoffTraceHistory> {
      await writeJsonl(piPath(dir), head);
      const history = await capture(PI, depsFor(dir));
      const chunk = filler(fillerDeltaMs).repeat(512);
      for (let written = 0; written <= TRACE_TAIL_BUDGET_BYTES; written += chunk.length) await appendFile(piPath(dir), chunk);
      return history;
    }

    it("a user turn just outside the tail with only anchor − 80 s non-user records inside it is scan_budget, never none", async () => {
      const dir = await root();
      const history = await oversized(dir, [...PI_QUIET, pi.message("user", 1_000)], -80_000);
      expect(await tailScan(PI, ANCHOR, history, depsFor(dir))).toEqual({ kind: "ambiguous", reason: "scan_budget" });
    }, 60_000);

    it("the same tail is proven once a record older than the slack boundary lies inside it", async () => {
      const dir = await root();
      const history = await oversized(dir, [...PI_QUIET], -80_000);
      await appendFile(piPath(dir), `${JSON.stringify(pi.state("model_change", -TRACE_TAIL_SLACK_MS - 1))}\n${JSON.stringify(pi.message("assistant", -1_000))}\n`);
      expect(await tailScan(PI, ANCHOR, history, depsFor(dir))).toEqual({ kind: "none" });
      // A follow-up appended after that boundary record is still found.
      await appendFile(piPath(dir), `${JSON.stringify(pi.message("user", 0))}\n`);
      expect(await tailScan(PI, ANCHOR, history, depsFor(dir))).toMatchObject({ kind: "user_turn" });
    }, 60_000);
  });

  it("F15: a trace shorter than the fingerprint or with a rewritten anchored prefix is a rollback", async () => {
    const dir = await root();
    await writeJsonl(piPath(dir), PI_QUIET);
    const history = await capture(PI, depsFor(dir));
    const position = history.position as { path: string; offset: number; anchor: string };
    expect(position.path).toBe(piSession.value);
    await truncate(piPath(dir), position.offset - 1);
    expect(await tailScan(PI, ANCHOR, history, depsFor(dir))).toMatchObject({ kind: "failure", failure: "source_rewritten", reason: "truncated" });
    // Same length, different bytes inside the anchored KiB.
    const rewritten = [...PI_QUIET.slice(0, 2), pi.message("assistant", OLD + 3_000)];
    await writeJsonl(piPath(dir), rewritten);
    expect(await tailScan(PI, ANCHOR, history, depsFor(dir))).toMatchObject({ kind: "failure", failure: "source_rewritten", reason: "anchor_mismatch" });
    // A history of the wrong kind can never vouch for this source.
    expect(await tailScan(PI, ANCHOR, { ...history, position: { session: "x", steps: 0, anchor: position.anchor } }, depsFor(dir))).toMatchObject({ kind: "failure", failure: "source_rewritten", reason: "history_kind" });
    expect(await tailScan(PI, ANCHOR, { ...history, kind: "devin-session" }, depsFor(dir))).toMatchObject({ kind: "failure", failure: "source_rewritten", reason: "history_kind" });
    expect(await tailScan(DEVIN, ANCHOR, history, depsFor(dir))).toMatchObject({ kind: "failure", failure: "source_rewritten", reason: "history_kind" });
  });

  it("the Claude path derives from the launch workspace through the owner-only project chain", async () => {
    const dir = await root();
    await writeJsonl(claudePath(dir), CLAUDE_QUIET);
    const history = await capture(CLAUDE, depsFor(dir));
    expect((history.position as { path: string }).path).toBe(claudePath(dir));
    expect(await tailScan(CLAUDE, ANCHOR, history, depsFor(dir))).toEqual({ kind: "none" });
    await chmod(join(dir, ".claude"), 0o707);
    expect(await tailScan(CLAUDE, ANCHOR, history, depsFor(dir))).toMatchObject({ kind: "failure", failure: "source_unreadable", reason: "untrusted:directory" });
  });
});

describe("tail scan: source trust and pointers", () => {
  const history: HandoffTraceHistory = { kind: "pi-jsonl", session: piSession, position: { path: piSession.value, offset: 0, anchor: sha256("") } };

  it("a missing, symlinked, or world-writable source is unreadable", async () => {
    const dir = await root();
    expect(await tailScan(PI, ANCHOR, history, depsFor(dir))).toMatchObject({ kind: "failure", failure: "source_unreadable", reason: "missing:leaf_stat" });
    await mkdir(dirname(piPath(dir)), { recursive: true, mode: 0o700 });
    await symlink(join(dir, "elsewhere"), piPath(dir));
    expect(await tailScan(PI, ANCHOR, history, depsFor(dir))).toMatchObject({ kind: "failure", failure: "source_unreadable", reason: expect.stringMatching(/^(untrusted|missing):/) });
    await rm(piPath(dir));
    await writeJsonl(piPath(dir), PI_QUIET);
    await chmod(piPath(dir), 0o666);
    expect(await tailScan(PI, ANCHOR, history, depsFor(dir))).toMatchObject({ kind: "failure", failure: "source_unreadable", reason: "untrusted:leaf" });
    // Group-writable alone (the agent CLIs' own 002 umask) is trusted.
    await chmod(piPath(dir), 0o664);
    expect(await tailScan(PI, ANCHOR, history, depsFor(dir))).toEqual({ kind: "none" });
  });

  it("a missing Devin document is unreadable, and a foreign opener fault propagates as a defect, never a verdict", async () => {
    const dir = await root();
    const devinHistory: HandoffTraceHistory = { kind: "devin-session", session: devinSession, position: { session: devinSession.value, steps: 0, anchor: sha256("") } };
    expect(await tailScan(DEVIN, ANCHOR, devinHistory, depsFor(dir))).toMatchObject({ kind: "failure", failure: "source_unreadable", reason: "missing:leaf_stat" });
    const faulting = depsFor(dir, { openFile: async () => { throw new TypeError("bug"); } });
    await expect(tailScan(DEVIN, ANCHOR, devinHistory, faulting)).rejects.toBeInstanceOf(TypeError);
    await expect(tailScan(PI, ANCHOR, history, faulting)).rejects.toBeInstanceOf(TypeError);
  });

  it("session pointers that cannot key a source refuse before any read", async () => {
    const dir = await root();
    const cases: Array<{ target: TraceTailTarget; reason: string }> = [
      { target: { agentKind: "pi", session: { ...piSession, kind: "id" } }, reason: "kind_not_path" },
      { target: { agentKind: "pi", session: { ...piSession, value: "relative.jsonl" } }, reason: "path_not_absolute" },
      { target: { agentKind: "claude", session: claudeSession }, reason: "workspace_unbound" },
      { target: { agentKind: "claude", session: { ...claudeSession, value: "not-a-uuid" }, workspace: { resolvedCwd: CWD } }, reason: "claude_session" },
      { target: { agentKind: "devin", session: { ...devinSession, kind: "path" } }, reason: "kind_not_id" },
      { target: { agentKind: "devin", session: { ...devinSession, value: "../escape" } }, reason: "id_not_filename_safe" },
      { target: { agentKind: "agy", session: piSession }, reason: "kind_unsupported" },
    ];
    for (const { target, reason } of cases) {
      expect(await tailScan(target, ANCHOR, history, depsFor(dir)), reason).toEqual({ kind: "failure", failure: "session_pointer_invalid", reason });
    }
  });
});

describe("history capture", () => {
  it("records the verified EOF less any pending tail, with the anchored prefix hash", async () => {
    const dir = await root();
    await writeJsonl(piPath(dir), PI_QUIET, '{"type":"message"');
    const complete = Buffer.byteLength(`${PI_QUIET.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const history = await capture(PI, depsFor(dir));
    const body = `${PI_QUIET.map((record) => JSON.stringify(record)).join("\n")}\n`;
    expect(history).toEqual({
      kind: "pi-jsonl",
      session: piSession,
      position: { path: piSession.value, offset: complete, anchor: sha256(Buffer.from(body).subarray(Math.max(0, complete - TRACE_HISTORY_ANCHOR_BYTES), complete)) },
    });
    // The pending record lands: the trace extends the fingerprint and the scan proceeds.
    await appendFile(piPath(dir), `,"id":"x","timestamp":"${at(-1_000)}","message":{"role":"assistant","content":"r"}}\n`);
    expect(await tailScan(PI, ANCHOR, history, depsFor(dir))).toEqual({ kind: "none" });
  });

  it("an empty JSONL trace anchors at offset 0", async () => {
    const dir = await root();
    await writeJsonl(piPath(dir), []);
    expect((await capture(PI, depsFor(dir))).position).toEqual({ path: piSession.value, offset: 0, anchor: sha256("") });
  });

  it("returns undefined for unsupported kinds, unresolvable pointers, missing or untrusted sources, over-budget or malformed Devin documents, and an unterminated tail longer than the budget", async () => {
    const dir = await root();
    const capt = (target: TraceTailTarget) => captureTraceHistory({ agentKind: target.agentKind, agentSession: target.session }, target.workspace, signal(), depsFor(dir));
    expect(await capt({ agentKind: "agy", session: piSession })).toBeUndefined();
    expect(await capt({ agentKind: "pi", session: { ...piSession, value: "relative" } })).toBeUndefined();
    expect(await capt(PI)).toBeUndefined();
    await writeJsonl(piPath(dir), PI_QUIET);
    await chmod(piPath(dir), 0o666);
    expect(await capt(PI)).toBeUndefined();
    await writeFile(devinPath(dir), Buffer.alloc(TRACE_TAIL_BUDGET_BYTES + 1, 0x20), { mode: 0o600 }).catch(async () => {
      await mkdir(dirname(devinPath(dir)), { recursive: true, mode: 0o700 });
      await writeFile(devinPath(dir), Buffer.alloc(TRACE_TAIL_BUDGET_BYTES + 1, 0x20), { mode: 0o600 });
    });
    expect(await capt(DEVIN)).toBeUndefined();
    await writeFile(devinPath(dir), "{not json", { mode: 0o600 });
    expect(await capt(DEVIN)).toBeUndefined();
    const aborted = new AbortController();
    aborted.abort();
    expect(await captureTraceHistory({ agentKind: "pi", agentSession: piSession }, undefined, aborted.signal, depsFor(dir))).toBeUndefined();
    await chmod(piPath(dir), 0o600);
    await writeFile(piPath(dir), Buffer.alloc(TRACE_TAIL_BUDGET_BYTES + 1, 0x20), { mode: 0o600 });
    expect(await capt(PI)).toBeUndefined();
  }, 60_000);

  it("anchors a short prefix by re-reading when the offset sits inside the first KiB of a budget-sized tail", async () => {
    const dir = await root();
    // The last newline lies within the first KiB after `start`, so the
    // anchored prefix begins before the tail buffer and is read separately.
    const line = `${JSON.stringify(pi.message("assistant", OLD))}\n`;
    const head = line.repeat(Math.ceil(TRACE_TAIL_BUDGET_BYTES / line.length) + 1);
    await mkdir(dirname(piPath(dir)), { recursive: true, mode: 0o700 });
    await writeFile(piPath(dir), `${head}${"x".repeat(TRACE_TAIL_BUDGET_BYTES - 200)}`, { mode: 0o600 });
    const history = await capture(PI, depsFor(dir));
    expect((history.position as { offset: number }).offset).toBe(head.length);
    expect((history.position as { anchor: string }).anchor).toBe(sha256(head.slice(head.length - TRACE_HISTORY_ANCHOR_BYTES)));
  }, 60_000);
});
