import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { skillTreeDigest } from "../../src/profiles/index.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("manager three-tool surface policy", () => {
  it("prescribes only the daemon-proxy surface and pins it across loaded copies", async () => {
    const canonicalPath = join(packageRoot, "herdr-profiles/role-plugins/manager/skills/manager");
    const loadedPath = join(packageRoot, "herdr-profiles/profile-plugins/manager/skills/manager");
    const canonical = await readFile(join(canonicalPath, "SKILL.md"), "utf8");
    expect(await readFile(join(loadedPath, "SKILL.md"), "utf8")).toBe(canonical);

    expect(canonical).toContain("Prefer the typed Herdr MCP namespace");
    expect(canonical).toContain("Use exactly these three operations: `herdr_launch`, `herdr_run`, and `herdr_status`.");
    // The daemon has no CLI caller path; the only sanctioned shell use is the
    // C8 follow-up recipe, which never touches daemon state.
    expect(canonical).toContain("there is no CLI equivalent");
    expect(canonical).toContain("`herdr agent prompt <TARGET> <TEXT>`");
    expect(canonical).toContain("executor→MCP gateway");
    // No removed tool may be prescribed, and no raw-CLI fallback for daemon
    // operations may remain.
    for (const removed of ["herdr_inspect", "herdr_communicate", "herdr_wait", "herdr_jobs", "herdr_pane", "herdr_tab"]) {
      expect(canonical).not.toContain(removed);
    }
    expect(canonical).not.toContain("raw `herdr` CLI fallback");
    expect(canonical).toContain("Never delegate Herdr work to a native subagent or the `Task` tool");
    expect(canonical).toContain("PROMPT_UNCONFIRMED");
    expect(canonical).toContain("Do not relaunch, resend the Task, auto-send Enter");
    expect(canonical).not.toContain("--stdin");

    const registry = JSON.parse(await readFile(join(packageRoot, "herdr-skill-bundles.json"), "utf8")) as {
      bundles: Record<string, { source: string; treeHash: string }>;
    };
    const record = registry.bundles["herdr-profiles/profile-plugins/manager/skills/manager"];
    expect(record.source).toBe("./herdr-profiles/role-plugins/manager/skills/manager");
    expect(record.treeHash).toBe(await skillTreeDigest(canonicalPath));
  });
});
