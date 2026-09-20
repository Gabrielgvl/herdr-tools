import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ReviewerRequest, ReviewerResult, WaitReviewer } from "../../src/reviewer.js";
import type { SupervisionPreviousReview, SupervisionSignalProbabilities } from "../../src/supervision/reviewer.js";
import { JobRegistry } from "../../src/job-registry.js";
import { prepareWait, runPreparedWait, type WaitCli, type WaitClock } from "../../src/tools/wait.js";

const snapshot = {
  type: "session_snapshot",
  snapshot: {
    version: "1", protocol: 1,
    workspaces: [{ workspace_id: "w", label: "w" }],
    tabs: [{ tab_id: "w:t", workspace_id: "w", label: "t" }],
    panes: [
      { pane_id: "p1", tab_id: "w:t", workspace_id: "w", label: "one", agent_name: "one", agent_status: "idle" },
      { pane_id: "p2", tab_id: "w:t", workspace_id: "w", label: "two", agent_name: "two", agent_status: "working" }
    ],
    agents: [{ pane_id: "p1", name: "one", agent_status: "idle" }, { pane_id: "p2", name: "two", agent_status: "working" }]
  }
};

const context = { workspaceId: "w", tabId: "w:t", paneId: "p1" };
const extensionContext = { modelRegistry: {} } as ExtensionContext;
const settings = { reviewCadenceMinutes: 1, reviewerModel: "testmodel", reviewerThinking: "low" as const };

function fakeCli(transcript: (paneId: string) => string): WaitCli {
  return {
    async runJson(argv) {
      if (argv[0] === "pane" && argv[1] === "current") return { id: "current", result: { type: "pane_current", pane: snapshot.snapshot.panes[0] } };
      if (argv[0] === "api") return { id: "snapshot", result: snapshot };
      return { id: "pane", result: { pane: snapshot.snapshot.panes.find((pane) => pane.pane_id === argv[2]) } };
    },
    async runText(argv) {
      return argv[0] === "pane" && argv[1] === "read" ? transcript(argv[2]!) : "";
    }
  };
}

function clock(): WaitClock {
  let now = 0;
  return { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } };
}

async function execute(cli: WaitCli, params: unknown, extra: Partial<Parameters<typeof prepareWait>[0]> = {}) {
  const deps = { cli, context, settingsLoader: async () => settings, jobRegistry: new JobRegistry(), ...extra } as Parameters<typeof prepareWait>[0];
  const prepared = await prepareWait(deps, params, new AbortController().signal);
  return runPreparedWait(deps, prepared, new AbortController().signal, () => undefined, extensionContext);
}

describe("wait reviewer temporal memory", () => {
  it("supplies previousReview from the second review on, so a silent window after observed work is not a false stall", async () => {
    const requests: ReviewerRequest[] = [];
    const reviewer: WaitReviewer = {
      review: async (request) => {
        requests.push(request);
        const previous = request.metadata.previousReview as SupervisionPreviousReview | undefined;
        // A silent window reads as a stall only when no prior work is on record.
        const classification = request.transcriptDelta.length === 0 && previous?.classification !== "progress" ? "stalled" : "progress";
        return { targetId: request.targetId, classification, summary: classification };
      }
    };
    const result = await execute(
      fakeCli(() => "compiled ok\nunit tests pass"),
      { targets: ["p1"], match: "all", condition: { kind: "output", match: { kind: "literal", value: "never" } }, timeoutMs: 120_001 },
      { clock: clock(), pollIntervalMs: 60_000, reviewerFactory: () => reviewer }
    );
    expect(result.wait_result).toBe("timed_out");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.metadata).not.toHaveProperty("previousReview");
    expect(requests[0]!.metadata.linesSinceLastReview).toBe(2);
    expect(requests[1]!.metadata.previousReview).toEqual({ classification: "progress" });
    expect(requests[1]!.metadata.linesSinceLastReview).toBe(0);
    expect(requests[1]!.transcriptDelta).toEqual([]);
  });

  it("keeps previousReview per target and per wait job", async () => {
    const signals: SupervisionSignalProbabilities = { progress: 0.7, stalled: 0.1, blocked: 0.05, risk: 0.02, appears_complete: 0.8 };
    const requests: ReviewerRequest[] = [];
    const reviewer: WaitReviewer = {
      review: async (request) => {
        requests.push(request);
        return request.targetId === "p2"
          ? { targetId: request.targetId, classification: "appears_complete", summary: "looks done", signals } as ReviewerResult
          : { targetId: request.targetId, classification: "progress", summary: "working" };
      }
    };
    const params = { targets: ["p1", "p2"], match: "all", condition: { kind: "output", match: { kind: "literal", value: "never" } }, timeoutMs: 120_001 };
    const result = await execute(fakeCli((paneId) => `${paneId} output`), params, { clock: clock(), pollIntervalMs: 60_000, reviewerFactory: () => reviewer });
    expect(result.wait_result).toBe("timed_out");
    expect(requests.map((request) => request.targetId)).toEqual(["p1", "p2", "p1", "p2"]);
    expect(requests[0]!.metadata).not.toHaveProperty("previousReview");
    expect(requests[1]!.metadata).not.toHaveProperty("previousReview");
    expect(requests[2]!.metadata.previousReview).toEqual({ classification: "progress" });
    expect(requests[3]!.metadata.previousReview).toEqual({ classification: "appears_complete", signals });

    const secondJob: ReviewerRequest[] = [];
    const secondReviewer: WaitReviewer = {
      review: async (request) => {
        secondJob.push(request);
        return { targetId: request.targetId, classification: "progress", summary: "working" };
      }
    };
    const second = await execute(fakeCli((paneId) => `${paneId} output`), params, { clock: clock(), pollIntervalMs: 60_000, reviewerFactory: () => secondReviewer });
    expect(second.wait_result).toBe("timed_out");
    expect(secondJob[0]!.metadata).not.toHaveProperty("previousReview");
    expect(secondJob[1]!.metadata).not.toHaveProperty("previousReview");
  });
});
