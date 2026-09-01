import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CORE_TOOL_NAMES } from "../../src/tool-surface.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = join(repoRoot, "herdr-profiles", "role-plugins", "manager");
const manifest = JSON.parse(readFileSync(join(packageRoot, ".claude-plugin/plugin.json"), "utf8")) as Record<string, unknown>;
const serverMap = JSON.parse(readFileSync(join(packageRoot, "mcp-servers.json"), "utf8")) as Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
const skill = readFileSync(join(packageRoot, "skills/manager/SKILL.md"), "utf8");

/**
 * The stdio command the server map may pin. Two forms are supported and nothing
 * else: the literal `node`, which is what the tracked canonical map carries and
 * what resolves through `PATH`, and the absolute path of an executable file
 * named `node`, which is what an operator whose Node is provided by a version
 * manager (Volta, nvm, asdf, a Nix profile) ends up pinning locally. Everything
 * else is rejected, including a relative path, a wrapper script under another
 * name, an argument-carrying command string, a shell, and an absolute path that
 * is not an executable file on this machine — a command the plugin host would
 * execute must be a real Node binary, not merely a plausible-looking string.
 */
function isSupportedNodeCommand(command: unknown): boolean {
  if (typeof command !== "string" || command.length === 0) return false;
  if (command === "node") return true;
  if (!isAbsolute(command) || basename(command) !== "node") return false;
  try {
    if (!statSync(command).isFile()) return false;
    accessSync(command, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function tree(directory: string, prefix = ""): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    const relative = prefix === "" ? entry : `${prefix}/${entry}`;
    return statSync(full).isDirectory() ? tree(full, relative) : [relative];
  }).sort();
}

describe("supported stdio Node command", () => {
  const fixtures = mkdtempSync(join(tmpdir(), "herdr-plugin-command-"));
  const executable = join(fixtures, "node");
  const unreadable = join(fixtures, "not-executable", "node");
  const renamed = join(fixtures, "nodejs");
  const directory = join(fixtures, "as-directory", "node");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  mkdirSync(dirname(unreadable), { recursive: true });
  writeFileSync(unreadable, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  writeFileSync(renamed, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  mkdirSync(directory, { recursive: true });

  afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

  it("accepts the literal command and an absolute executable named node", () => {
    expect(isSupportedNodeCommand("node")).toBe(true);
    expect(isSupportedNodeCommand(executable)).toBe(true);
    // The Node running this suite is itself a supported pin on any platform
    // whose interpreter is named `node`, which is the case this contract exists
    // for; assert it only there so the check stays a fact, not a guess.
    if (basename(process.execPath) === "node") expect(isSupportedNodeCommand(process.execPath)).toBe(true);
  });

  it("rejects every other command shape", () => {
    for (const rejected of [
      "",
      "  ",
      "sh",
      "bash",
      "nodejs",
      "node --experimental-strip-types",
      "/usr/bin/env node",
      "./node",
      join("relative", "node"),
      `${executable} --inspect`,
      renamed,
      unreadable,
      directory,
      join(fixtures, "missing", "node"),
      fixtures
    ]) {
      expect(isSupportedNodeCommand(rejected), rejected).toBe(false);
    }
    for (const rejected of [undefined, null, 0, false, ["node"], { command: "node" }]) {
      expect(isSupportedNodeCommand(rejected), JSON.stringify(rejected) ?? "undefined").toBe(false);
    }
  });
});

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
    const entry = serverMap.herdr!;
    // The entry carries nothing but the command and its args: no `env`, no
    // transport override, no working directory.
    expect(Object.keys(entry).sort()).toEqual(["args", "command"]);
    expect(entry.args).toEqual(["/home/gabriel/.pi/agent/extensions/herdr-tools/dist/src/mcp-server.js"]);
    // The command is asserted semantically, not literally: the tracked map pins
    // `node`, while a locally installed copy may pin the absolute Node binary a
    // version manager selected. Both run the same entry; nothing else may.
    expect(isSupportedNodeCommand(entry.command), `unsupported stdio command ${JSON.stringify(entry.command)}`).toBe(true);
    // `CLAUDE_PROJECT_DIR` is exported to MCP server subprocesses by Claude Code
    // itself, verified live against a loaded plugin, so no explicit `env`
    // mapping is carried. The server still refuses to start without it.
    expect(entry.env).toBeUndefined();
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
