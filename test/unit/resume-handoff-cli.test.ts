import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// The script binds to dist/: a build artifact, not a source contract, so the
// gate skips when no build exists rather than faking one.
describe.skipIf(!existsSync("dist/src/handoff-resume.js"))("resume-handoff CLI", () => {
  it("prints a USAGE error and exits 1 without a valid run id", () => {
    for (const args of [[], ["not-a-run-id"]]) {
      const run = spawnSync("node", ["scripts/resume-handoff.mjs", ...args], { encoding: "utf8" });
      expect(run.status).toBe(1);
      expect(JSON.parse(run.stderr)).toMatchObject({ error: "USAGE" });
    }
  });
});
