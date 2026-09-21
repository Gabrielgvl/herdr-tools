import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ABC_OUTCOME_TYPE,
  ABC_REPLAY_TYPE,
  measureAbc,
  measureAbcFiles,
  readJsonl,
} from "../../scripts/measure-abc.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-measure-abc-"));
  dirs.push(dir);
  return dir;
}

const signalProbabilities = (overrides: Record<string, number> = {}) => ({
  progress: 0.1,
  stalled: 0.1,
  blocked: 0.1,
  risk: 0.1,
  appears_complete: 0.1,
  ...overrides,
});

const outcome = (jobId: string, reviewAtMs: number, signals: Record<string, boolean>, wake: boolean) => ({
  type: ABC_OUTCOME_TYPE,
  jobId,
  reviewAtMs,
  signals: { progress: false, stalled: false, blocked: false, risk: false, ...signals },
  wake,
});

const replay = (jobId: string, reviewAtMs: number, representation: string, overrides: Record<string, unknown> = {}) => ({
  type: ABC_REPLAY_TYPE,
  jobId,
  reviewAtMs,
  representation,
  evidenceSufficiency: 0.9,
  signals: signalProbabilities(),
  previousClassification: null,
  attention: false,
  ...overrides,
});

const supervisionView = {
  compiler: "vcc-supervision",
  compilerVersion: "v2.2-a",
  contractVersion: 1,
  source: "runner-jsonl",
  lines: [{ ref: "#1", text: "READ file.ts SUCCESS" }],
  rawEventCount: 1,
  truncated: false,
  digestHash: "a".repeat(64),
};

describe("ADR-036 A/B/C measurement", () => {
  it("computes evidence, per-signal accuracy, cost, and wake errors for paired cadences", () => {
    const report = measureAbc([
      outcome("job-1", 1, { progress: true }, false),
      outcome("job-2", 2, { stalled: true }, true),
      replay("job-1", 1, "A-tmux-lines", { signals: signalProbabilities({ progress: 0.9 }), tokens: 100, payloadBytes: 400 }),
      replay("job-2", 2, "A-tmux-lines", {
        signals: signalProbabilities({ progress: 0.7, stalled: 0.8 }),
        previousClassification: "progress",
        attention: false,
        tokens: 150,
        payloadBytes: 600,
      }),
      replay("job-1", 1, "B-runner-trace", {
        signals: signalProbabilities({ stalled: 0.8 }),
        attention: true,
        tokens: 60,
        payload: "four",
      }),
      replay("job-2", 2, "B-runner-trace", {
        evidenceSufficiency: 0.5,
        signals: signalProbabilities({ stalled: 0.95 }),
        previousClassification: "progress",
        attention: true,
      }),
      replay("job-1", 1, "C-vcc-supervision-view", {
        signals: signalProbabilities({ progress: 0.95 }),
        supervisionView,
        tokens: 40,
      }),
      replay("job-2", 2, "C-vcc-supervision-view", {
        signals: signalProbabilities({ stalled: 0.99 }),
      }),
    ]);

    expect(report.diagnostics).toMatchObject({
      inputRecords: 8,
      replayRecords: 6,
      outcomeRecords: 2,
      rejectedCReplays: 1,
      unpairedObservations: 0,
    });

    const a = report.representations["A-tmux-lines"];
    expect(a).toMatchObject({
      status: "measured",
      observations: 2,
      pairedCadences: 2,
      evidenceSufficient: { numerator: 2, denominator: 2, rate: 1 },
      tokens: { samples: 2, total: 250, mean: 125 },
      payloadBytes: { samples: 2, total: 1_000, mean: 500 },
      falsePositiveWakeups: { numerator: 0, denominator: 1, rate: 0 },
      missedWakeups: { numerator: 1, denominator: 1, rate: 1 },
    });
    expect(a.accuracy.progress).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(a.accuracy.stalled).toEqual({ numerator: 2, denominator: 2, rate: 1 });
    expect(a.accuracy.blocked.rate).toBe(1);
    expect(a.accuracy.risk.rate).toBe(1);

    const b = report.representations["B-runner-trace"];
    expect(b.evidenceSufficient.rate).toBe(0.5);
    expect(b.accuracy.progress.rate).toBe(0.5);
    expect(b.accuracy.stalled.rate).toBe(0.5);
    expect(b.tokens).toEqual({ samples: 1, total: 60, mean: 60 });
    expect(b.payloadBytes).toEqual({ samples: 1, total: 4, mean: 4 });
    expect(b.falsePositiveWakeups.rate).toBe(1);
    expect(b.missedWakeups.rate).toBe(0);

    const c = report.representations["C-vcc-supervision-view"];
    expect(c.status).toBe("measured");
    expect(c.observations).toBe(1);
    expect(c.accuracy.progress.rate).toBe(1);
    expect(c.payloadBytes).toEqual({
      samples: 1,
      total: Buffer.byteLength(JSON.stringify(supervisionView)),
      mean: Buffer.byteLength(JSON.stringify(supervisionView)),
    });
  });

  it("infers legacy 100-line reviews as A and skips fixture C without V2.2-a output", () => {
    const report = measureAbc([
      {
        type: "review",
        jobId: "legacy",
        atMs: 3,
        attention: true,
        evidenceSufficiency: 0.7,
        signals: signalProbabilities({ blocked: 0.8 }),
        previousClassification: null,
        evidence: { transcriptLines: 100 },
      },
      replay("legacy", 3, "C-vcc-supervision-view"),
      { name: "router decision", result: { kind: "admitted" } },
    ]);

    expect(report.diagnostics).toMatchObject({
      reviewRecords: 1,
      inferredLegacyARecords: 1,
      rejectedCReplays: 1,
      ignoredRecords: 1,
      unpairedObservations: 1,
    });
    expect(report.representations["A-tmux-lines"]).toMatchObject({ status: "measured", observations: 1 });
    expect(report.representations["C-vcc-supervision-view"]).toMatchObject({
      status: "skipped",
      reason: "vcc_supervision_view_unavailable",
      observations: 0,
    });
  });

  it("reads persisted review and decision JSONL plus replay fixtures without a live launch", async () => {
    const dir = await tempdir();
    const reviewsPath = join(dir, "reviews.jsonl");
    const decisionsPath = join(dir, "decisions.jsonl");
    const fixturePath = join(dir, "fixture.jsonl");
    await writeFile(reviewsPath, `${JSON.stringify({
      type: "review",
      jobId: "persisted",
      atMs: 4,
      attention: false,
      evidenceSufficiency: 0.8,
      signals: signalProbabilities({ progress: 0.9 }),
      previousClassification: null,
      provenance: { representation: "B-runner-trace", stateBytes: 321 },
    })}\n`);
    await writeFile(decisionsPath, `${JSON.stringify(outcome("persisted", 4, { progress: true }, false))}\n`);
    await writeFile(fixturePath, "\n");

    const report = await measureAbcFiles({ reviewsPath, decisionsPath, fixturePaths: [fixturePath] });
    expect(report.representations["B-runner-trace"]).toMatchObject({
      observations: 1,
      pairedCadences: 1,
      payloadBytes: { samples: 1, total: 321, mean: 321 },
      tokens: { samples: 0, total: 0, mean: null },
    });

    await writeFile(fixturePath, "not-json\n");
    await expect(readJsonl(fixturePath)).rejects.toThrow(`${fixturePath}:1 is not valid JSON`);
  });
});
