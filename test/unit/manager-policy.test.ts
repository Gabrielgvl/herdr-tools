import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { skillTreeDigest } from "../../src/profiles/index.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("manager raw CLI fallback policy", () => {
  it("keeps fallback owner-gated, bounded, and pinned across loaded copies", async () => {
    const canonicalPath = join(packageRoot, "herdr-profiles/role-plugins/manager/skills/manager");
    const loadedPath = join(packageRoot, "herdr-profiles/profile-plugins/manager/skills/manager");
    const canonical = await readFile(join(canonicalPath, "SKILL.md"), "utf8");
    expect(await readFile(join(loadedPath, "SKILL.md"), "utf8")).toBe(canonical);

    expect(canonical).toContain("Prefer the typed Herdr MCP namespace");
    expect(canonical).toContain("If typed Herdr capability is unavailable or incompatible, raw `herdr` CLI fallback through the host's owner-gated shell tool is permitted only when the owner directly authorizes it for the current task.");
    expect(canonical).not.toContain("Use only the typed Herdr MCP namespace");
    expect(canonical).not.toContain("Never drive Herdr through Bash, a raw `herdr` command");
    expect(canonical).not.toContain("Communicate only through `herdr_communicate` and `herdr_launch`");
    expect(canonical).toContain("authorized raw-CLI fallback must preserve that envelope");
    expect(canonical).toContain("Raw agent start cannot mint a typed supervisor job: disclose missing typed auto-supervisor coverage, use only available native bounded wait/review support, and never claim equivalence with typed supervision.");
    expect(canonical).toContain("Never delegate Herdr work to a native subagent or the `Task` tool");
    expect(canonical).toContain("Do not retry, add escalation keys");
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
