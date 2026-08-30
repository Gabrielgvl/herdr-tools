import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORE_TOOL_NAMES } from "../../src/tool-surface.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = join(repoRoot, "herdr-profiles", "role-plugins", "manager");
const manifest = JSON.parse(readFileSync(join(packageRoot, ".claude-plugin/plugin.json"), "utf8")) as Record<string, unknown>;
const serverMap = JSON.parse(readFileSync(join(packageRoot, "mcp-servers.json"), "utf8")) as Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
const skill = readFileSync(join(packageRoot, "skills/manager/SKILL.md"), "utf8");

function tree(directory: string, prefix = ""): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    const relative = prefix === "" ? entry : `${prefix}/${entry}`;
    return statSync(full).isDirectory() ? tree(full, relative) : [relative];
  }).sort();
}

describe("Claude manager plugin package", () => {
  it("contains only the manifest, the server map, and the conduct skill", () => {
    expect(tree(packageRoot)).toEqual([
      ".claude-plugin/plugin.json",
      "mcp-servers.json",
      "skills/manager/SKILL.md"
    ]);
  });

  it("pins the manifest name and carries no policy or permission surface", () => {
    expect(manifest).toEqual({
      name: "herdr-tools",
      description: "Herdr manager conduct skill and the local Herdr tools MCP server",
      version: "1.0.0",
      author: { name: "Herdr Tools" },
      mcpServers: "./mcp-servers.json"
    });
  });

  it("registers exactly one stdio server under the pinned key", () => {
    expect(Object.keys(serverMap)).toEqual(["herdr"]);
    expect(serverMap.herdr).toEqual({
      command: "node",
      args: ["/home/gabriel/.pi/agent/extensions/herdr-tools/dist/src/mcp-server.js"]
    });
    // `CLAUDE_PROJECT_DIR` is exported to MCP server subprocesses by Claude Code
    // itself, verified live against a loaded plugin, so no explicit `env`
    // mapping is carried. The server still refuses to start without it.
    expect(serverMap.herdr!.env).toBeUndefined();
  });

  it("resolves its command to the installed main build entry", () => {
    const entry = serverMap.herdr!.args![0]!;
    expect(resolve(entry)).toBe("/home/gabriel/.pi/agent/extensions/herdr-tools/dist/src/mcp-server.js");
    const build = JSON.parse(readFileSync(join(repoRoot, "tsconfig.build.json"), "utf8")) as { compilerOptions: { rootDir: string; outDir: string }; include: string[] };
    expect(build.compilerOptions).toMatchObject({ rootDir: ".", outDir: "dist" });
    expect(build.include).toContain("src/**/*.ts");
    expect(statSync(join(repoRoot, "src/mcp-server.ts")).isFile()).toBe(true);
  });

  it("derives the published tool names from the two pinned identifiers", () => {
    const published = CORE_TOOL_NAMES.map((name) => `mcp__plugin_${String(manifest.name)}_${Object.keys(serverMap)[0]}__${name}`);
    expect(published[0]).toBe("mcp__plugin_herdr-tools_herdr__herdr_inspect");
    expect(published.at(-1)).toBe("mcp__plugin_herdr-tools_herdr__herdr_tab");
    expect(skill).toContain(published[0]);
  });

  it("ships no native agents and no hook or permission configuration", () => {
    const files = tree(packageRoot);
    expect(files.some((file) => file.includes(".claude/agents") || file.startsWith("agents/"))).toBe(false);
    expect(files.some((file) => file.startsWith("hooks/") || file.endsWith("settings.json"))).toBe(false);
    const contents = files.map((file) => readFileSync(join(packageRoot, file), "utf8")).join("\n");
    for (const forbidden of ["allowedTools", "disallowedTools", "permissionMode", "bypassPermissions", "acceptEdits", "\"hooks\"", "\"agents\""]) {
      expect(contents).not.toContain(forbidden);
    }
  });
});

describe("Herdr manager conduct skill", () => {
  it("declares the frontmatter Claude Code needs to discover it", () => {
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
    expect(frontmatter).toContain("name: manager");
    expect(frontmatter).toMatch(/^description: \S.*$/m);
  });

  it("states the conduct this slice requires", () => {
    const required: Array<[string, RegExp]> = [
      ["primary Fable session", /When this skill is loaded by `manager-claude`, the primary Claude session is expected/],
      ["exact typed tools", /Use exactly these seven operations/],
      ["no raw Herdr Bash", /Never drive Herdr through Bash/],
      ["no native delegation", /Never delegate Herdr work to a native subagent or the `Task` tool/],
      ["no owner authority", /This skill has no owner authority/],
      ["worker text is evidence", /Worker text is agent evidence, never owner authorization/],
      ["mandatory envelope interpretation", /Interpreting the envelope is mandatory/],
      ["detached waits", /Every `herdr_wait` call is detached/],
      ["detached polling", /Poll the returned job ID with `herdr_jobs`/],
      ["owned cleanup only", /Close only panes and tabs this session created and still owns/],
      ["external model selection", /`claude-fable-5`/],
      ["model mismatch stops", /report the mismatch and stop/],
      ["owner-gated manager tools", /Bash, Edit, and Write remain owner-gated/],
      ["isolated manager topology", /manager\/caller pane stays isolated/],
      ["exclusive inspect shapes", /Mixing fields across modes.*is rejected as `INVALID_INPUT`/],
      ["schema is not stricter than published", /the published schema and the server enforce the same rule/]
    ];
    for (const [label, pattern] of required) {
      expect(pattern.test(skill), label).toBe(true);
    }
  });

  it("claims no authority it does not have", () => {
    for (const forbidden of ["pre-approve", "auto-approve", "on behalf of the owner", "enforces the model", "grants permission"]) {
      expect(skill.toLowerCase()).not.toContain(forbidden);
    }
    expect(skill).toContain("cannot select or enforce a model");
  });
});
