import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HOTFIX_HOST_FILES, HOTFIX_LABEL, HOTFIX_MANDATORY_CASES, REQUIRED_SESSION, childExitCode, validateHotfixReceipt, vitestArguments } from "../../scripts/test-stdin-hotfix.js";

function validReceipt(): Record<string, unknown> {
  const body = "body";
  const hash = createHash("sha256").update(body).digest("hex");
  const receipts = HOTFIX_MANDATORY_CASES.map((caseName) => ({
    case: caseName,
    effect: "confirmed",
    source: "recipient-generated",
    observedBodySource: "recipient-body-file",
    session: REQUIRED_SESSION,
    expectedBodyBytes: body.length,
    observedBodyBytes: body.length,
    expectedBodySha256: hash,
    observedBodySha256: hash,
    nativeRequestId: `request-${caseName}`,
    requestCount: 1,
    actualCommandExitCode: 0,
    commandExitFilePath: `/tmp/${caseName}.exit`,
    identity: {
      paneId: `pane-${caseName}`,
      terminalId: `terminal-${caseName}`,
      agentName: `recipient-${caseName}`,
      agentKind: "pi",
      agentSession: { source: "herdr", agent: "recipient", kind: "id", value: `session-${caseName}` }
    }
  }));
  return {
    label: HOTFIX_LABEL,
    host: "mcp",
    status: "passed",
    actualExitCode: 0,
    mandatoryCases: [...HOTFIX_MANDATORY_CASES],
    toolSmoke: ["herdr_launch", "herdr_run", "herdr_status"],
    mcpPollingDifference: "bounded polling",
    receipts
  };
}

describe("Pi-only hotfix runner", () => {
  it("selects both exact host files without a name filter", () => {
    expect(vitestArguments()).toEqual(["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.hotfix.config.ts", ...HOTFIX_HOST_FILES]);
    expect(HOTFIX_LABEL).toBe("HOTFIX_PI_ONLY");
    expect(HOTFIX_HOST_FILES).toEqual(["test/hotfix/pi.stdin.hotfix.test.ts", "test/hotfix/mcp.stdio.hotfix.test.ts"]);
  });

  it("propagates a nonzero child status and fails closed for an unknown status", () => {
    expect(childExitCode({ status: 23, error: undefined })).toBe(23);
    expect(childExitCode({ status: 0, error: undefined })).toBe(0);
    expect(childExitCode({ status: null, error: undefined })).toBe(1);
    expect(childExitCode({ status: 0, error: new Error("spawn failed") })).toBe(1);
  });

  it("accepts recipient body provenance and rejects mismatched hashes or kinds", () => {
    const receipt = validReceipt();
    expect(() => validateHotfixReceipt(receipt, "mcp")).not.toThrow();
    const mismatchedHash = structuredClone(receipt) as Record<string, unknown>;
    const hashReceipt = (mismatchedHash.receipts as Array<Record<string, unknown>>)[0]!;
    hashReceipt.observedBodySha256 = "0".repeat(64);
    expect(() => validateHotfixReceipt(mismatchedHash, "mcp")).toThrow(/bodies differ/u);
    const mismatchedKind = structuredClone(receipt) as Record<string, unknown>;
    const kindReceipt = (mismatchedKind.receipts as Array<Record<string, unknown>>).find((item) => item.case === "pi-inline-launch")!;
    (kindReceipt.identity as Record<string, unknown>).agentKind = "claude";
    expect(() => validateHotfixReceipt(mismatchedKind, "mcp")).toThrow(/wrong recipient kind/u);
  });
});
