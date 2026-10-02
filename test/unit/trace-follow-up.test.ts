/**
 * The follow-up decision (ADR-040 amendment node E): every §4.4 row maps to
 * its reason, the artifact re-hash is content-only, and the anchor handed to
 * the tail scan is the PERSISTED `artifact.mtimeMs` (F13).
 */
import { describe, expect, it } from "vitest";
import { HandoffError, type HandoffArtifact, type HandoffState, type HandoffTraceHistory } from "../../src/handoff.js";
import type { AgentSessionIdentity } from "../../src/messages/prompt.js";
import { followUpVeto, type TailScanner } from "../../src/supervision/trace-follow-up.js";
import type { TailScan } from "../../src/supervision/trace-tail.js";

const session: AgentSessionIdentity = { source: "herdr:pi", agent: "pi", kind: "path", value: "/pi/session.jsonl" };
const ANCHOR = Date.parse("2026-10-01T12:00:00.000Z");
const SHA = "a".repeat(64);
const history: HandoffTraceHistory = { kind: "pi-jsonl", session, position: { path: session.value, offset: 10, anchor: "b".repeat(64) } };

function state(over: Partial<HandoffState["artifact"]> = {}, child: Partial<HandoffState["child"]> = {}, nativeSession: HandoffState["nativeSession"] = session): HandoffState {
  return {
    v: 2,
    runId: "11111111-2222-4333-8444-555555555555",
    endpoint: "/sock",
    createdAt: "2026-10-01T00:00:00.000Z",
    manager: { paneId: "p-owner", display: "pi", source: "agent_name" },
    child: { agentName: "worker", agentKind: "pi", operatingPointId: "op", specLabel: "worker", fallbackCandidates: [], paneId: "p", terminalId: "t", agentId: null, workspace: { resolvedCwd: "/project" }, ...child },
    nativeSession,
    lifecycle: { state: "handed_off", watermark: null },
    artifact: { path: "/run/handoff.md", sha256: SHA, bytes: 10, version: 1, status: "done", mtimeMs: ANCHOR, traceHistory: history, ...over },
    repair: { attempts: 0, fence: null },
  };
}

const fresh = (over: Partial<HandoffArtifact> = {}): HandoffArtifact => ({
  runId: "11111111-2222-4333-8444-555555555555",
  status: "done",
  sections: { Status: "done", Summary: "s", Changes: "None", Verification: "v", Blockers: "None", Continuation: "None" },
  bytes: 10,
  sha256: SHA,
  // Later than the persisted anchor: a byte-identical rewrite.
  mtimeMs: ANCHOR + 120_000,
  ...over,
});

const scanning = (result: TailScan): { scan: TailScanner; calls: Array<{ anchorMs: number; target: Parameters<TailScanner>[0]; history: Parameters<TailScanner>[2]; deps: Parameters<TailScanner>[3] }> } => {
  const calls: Array<{ anchorMs: number; target: Parameters<TailScanner>[0]; history: Parameters<TailScanner>[2]; deps: Parameters<TailScanner>[3] }> = [];
  return {
    calls,
    scan: async (target, anchorMs, hist, deps) => {
      calls.push({ anchorMs, target, history: hist, deps });
      return result;
    },
  };
};

describe("followUpVeto", () => {
  it("refuses before any read: unsupported kind, missing anchor or sha, missing or stale history", async () => {
    const { scan, calls } = scanning({ kind: "none" });
    const reads: number[] = [];
    const read = async () => { reads.push(1); return fresh(); };
    expect(await followUpVeto(state({}, { agentKind: "agy" }), read, { scan })).toEqual({ state: "refused", reason: "trace_unsupported_kind" });
    expect(await followUpVeto(state({ mtimeMs: undefined }), read, { scan })).toEqual({ state: "refused", reason: "trace_anchor_missing" });
    expect(await followUpVeto(state({ sha256: null }), read, { scan })).toEqual({ state: "refused", reason: "trace_anchor_missing" });
    expect(await followUpVeto(state({ traceHistory: undefined }), read, { scan })).toEqual({ state: "refused", reason: "trace_history_missing" });
    expect(await followUpVeto(state({ traceHistory: { ...history, session: { ...session, value: "/pi/other.jsonl" } } }), read, { scan })).toEqual({ state: "refused", reason: "trace_history_stale" });
    expect(await followUpVeto(state({}, {}, null), read, { scan })).toEqual({ state: "refused", reason: "trace_history_stale" });
    expect(reads).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("maps every artifact refusal to its code, propagates foreign throws, and refuses changed bytes", async () => {
    const { scan, calls } = scanning({ kind: "none" });
    const codes: Array<[HandoffError["code"], string]> = [
      ["HANDOFF_ARTIFACT_MISSING", "missing"],
      ["HANDOFF_ARTIFACT_INVALID", "invalid"],
      ["HANDOFF_ARTIFACT_OVERSIZED", "oversized"],
      ["HANDOFF_ARTIFACT_UNTRUSTED", "untrusted"],
      ["HANDOFF_STORE_FAILED", "unavailable"],
    ];
    for (const [code, reason] of codes) {
      expect(await followUpVeto(state(), async () => { throw new HandoffError(code, "x"); }, { scan })).toEqual({ state: "refused", reason: `trace_artifact_${reason}` });
    }
    await expect(followUpVeto(state(), async () => { throw new TypeError("bug"); }, { scan })).rejects.toBeInstanceOf(TypeError);
    expect(await followUpVeto(state(), async () => fresh({ sha256: "c".repeat(64) }), { scan })).toEqual({ state: "refused", reason: "trace_artifact_changed" });
    expect(calls).toEqual([]);
  });

  it("F13: scans against the persisted anchor and the recorded history, never the fresh artifact's mtime", async () => {
    const { scan, calls } = scanning({ kind: "none" });
    const trace = { rootDir: "/virtual" };
    expect(await followUpVeto(state(), async () => fresh(), { scan, trace })).toBeUndefined();
    expect(calls).toEqual([{ anchorMs: ANCHOR, target: { agentKind: "pi", session, workspace: { resolvedCwd: "/project" } }, history, deps: trace }]);
    // A child without a workspace record passes no workspace.
    const bare = state();
    delete bare.child.workspace;
    await followUpVeto(bare, async () => fresh(), { scan });
    expect(calls[1]!.target).toEqual({ agentKind: "pi", session });
  });

  it("maps every scan outcome to its reason", async () => {
    const outcomes: Array<[TailScan, string]> = [
      [{ kind: "failure", failure: "source_unreadable", reason: "missing:leaf_stat" }, "trace_source_unreadable"],
      [{ kind: "failure", failure: "source_malformed", reason: "record:0" }, "trace_source_malformed"],
      [{ kind: "failure", failure: "source_exceeds_budget", reason: "document" }, "trace_source_exceeds_budget"],
      [{ kind: "failure", failure: "session_pointer_invalid", reason: "kind_not_path" }, "trace_session_pointer_invalid"],
      [{ kind: "failure", failure: "source_rewritten", reason: "truncated" }, "trace_source_rewritten"],
      [{ kind: "pending_tail" }, "trace_pending_tail"],
      [{ kind: "user_turn", atMs: ANCHOR }, "trace_follow_up"],
      [{ kind: "ambiguous", reason: "scan_budget" }, "trace_ambiguous:scan_budget"],
      [{ kind: "ambiguous", reason: "timestamp_missing" }, "trace_ambiguous:timestamp_missing"],
    ];
    for (const [result, reason] of outcomes) {
      expect(await followUpVeto(state(), async () => fresh(), { scan: scanning(result).scan }), reason).toEqual({ state: "refused", reason });
    }
  });
});
