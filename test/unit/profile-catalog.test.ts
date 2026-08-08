import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeArgv, buildPiArgv, discoverProfiles, parseProfile, profileSource, resolveProfile, ProfileParseError, ProfileResolutionError } from "../../src/profiles/index.js";
import { createInspectTool } from "../../src/tools/inspect.js";
import { createLaunchTool } from "../../src/tools/launch.js";
import type { HerdrCli } from "../../src/cli.js";

function source(root: string, name: string) { return profileSource("project", join(root, `${name}.md`), root); }
function profileText(name: string, runtime = "pi", extra = "", fallbacks = "[]") {
  const block = runtime === "pi" ? "  kind: pi\n  model: test/model\n  thinking: low\n  extensions: []\n  skills: []" : "  kind: claude\n  model: claude-test\n  permissionMode: default\n  extensions: []\n  skills: []";
  return `---\nname: ${name}\ndescription: Test ${name}\nruntime:\n${block}\nfallbacks: ${fallbacks}\n${extra}---\n\nBody for ${name}.\n`;
}

const noCli = { runJson: async () => { throw new Error("CLI must not be called"); }, runText: async () => { throw new Error("CLI must not be called"); } } as unknown as HerdrCli;

describe("profile catalog", () => {
  it("parses strict YAML profiles and resolves scoped runtime resources", () => {
    const root = "/tmp/profile-scope";
    const parsed = parseProfile(profileText("worker", "pi", ""), source(root, "worker"));
    expect(parsed.runtime).toMatchObject({ kind: "pi", model: "test/model", thinking: "low" });
    expect(parsed.body).toContain("Body for worker");
    expect(() => parseProfile(profileText("worker", "pi", "extra: true\n"), source(root, "worker"))).toThrow(ProfileParseError);
    expect(() => parseProfile(profileText("Worker"), source(root, "Worker"))).toThrow(ProfileParseError);
    expect(() => parseProfile(profileText("worker", "pi", ""), source(root, "other"))).toThrow(ProfileParseError);
    expect(() => parseProfile(profileText("worker", "pi", "" ).replace("extensions: []", "extensions: [/tmp/x]"), source(root, "worker"))).toThrow(ProfileParseError);
  });

  it("discovers project over user over bundled and isolates invalid profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-profile-"));
    const bundled = join(root, "bundled");
    const user = join(root, "user");
    const project = join(root, "project");
    await Promise.all([mkdir(bundled), mkdir(user), mkdir(project)]);
    await writeFile(join(bundled, "worker.md"), profileText("worker"));
    await writeFile(join(user, "worker.md"), profileText("worker", "claude"));
    await writeFile(join(project, "worker.md"), profileText("worker"));
    await writeFile(join(bundled, "broken.md"), "---\nname: broken\nunknown: yes\n---\n\nnope\n");
    const catalog = await discoverProfiles({ bundledDir: bundled, userDir: user, projectDir: project });
    expect(catalog.effective.get("worker")?.source.kind).toBe("project");
    expect(catalog.effective.has("broken")).toBe(false);
    expect(catalog.diagnostics.some((item) => item.code === "SHADOWED_PROFILE")).toBe(true);
    expect(catalog.diagnostics.some((item) => item.code === "INVALID_PROFILE" && item.name === "broken")).toBe(true);
  });

  it("validates only the selected reachable fallback graph", () => {
    const root = "/tmp/profile-scope";
    const make = (name: string, fallbacks: string[]) => parseProfile(profileText(name, "pi", "", JSON.stringify(fallbacks)), source(root, name));
    const effective = new Map([make("root", ["next"]), make("next", ["last"]), make("last", [])].map((item) => [item.name, item] as const));
    const resolution = resolveProfile("root", { effective, candidates: [], diagnostics: [] });
    expect(resolution.reachableNames).toEqual(["root", "next", "last"]);
    expect(resolution.fallbackNames).toEqual(["next"]);
    const missing = make("root", ["missing"]);
    expect(() => resolveProfile("root", { effective: new Map([[missing.name, missing]]), candidates: [], diagnostics: [] })).toThrow(ProfileResolutionError);
    const cycle = new Map([make("root", ["next"]), make("next", ["root"])].map((item) => [item.name, item] as const));
    expect(() => resolveProfile("root", { effective: cycle, candidates: [], diagnostics: [] })).toThrow(ProfileResolutionError);
  });

  it("produces shell-free typed runtime arguments and rejects cross-kind overrides", () => {
    const pi = parseProfile(profileText("worker"), source("/tmp/profile-scope", "worker"));
    const claude = parseProfile(profileText("reviewer", "claude"), source("/tmp/profile-scope", "reviewer"));
    expect(buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, { model: "override/model", thinking: "high" })).toEqual(["--model", "override/model", "--thinking", "high"]);
    expect(buildClaudeArgv(claude.runtime as Extract<typeof claude.runtime, { kind: "claude" }>)).toEqual(["--model", "claude-test", "--permission-mode", "default"]);
    expect(() => buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, { thinking: "not-valid" as never })).toThrow();
  });

  it("launches a resolved profile through the existing placement path without raw argv", async () => {
    const root = "/tmp/profile-scope";
    const worker = parseProfile(profileText("worker"), source(root, "worker"));
    const calls: string[][] = [];
    const snapshot = { type: "session_snapshot", snapshot: { version: "0.8", protocol: 1, workspaces: [{ workspace_id: "w", label: "workspace" }], tabs: [{ tab_id: "w:t", workspace_id: "w", label: "main" }], panes: [{ pane_id: "w:p", tab_id: "w:t", workspace_id: "w", label: "caller", agent_status: "idle" }], agents: [] } };
    const cli = { runJson: async (argv: string[]) => {
      calls.push(argv);
      if (argv[0] === "api") return { id: "snapshot", result: snapshot };
      if (argv[0] === "pane" && argv[1] === "split") return { id: "split", result: { pane: { pane_id: "w:p2", tab_id: "w:t" } } };
      if (argv[0] === "pane" && argv[1] === "rename") return { id: "rename", result: {} };
      if (argv[0] === "agent" && argv[1] === "start") return { id: "start", result: { agent: { name: "worker", agent_id: "a" } } };
      if (argv[0] === "pane" && argv[1] === "get") return { id: "get", result: { pane: { pane_id: "w:p2", tab_id: "w:t", agent_name: "worker", agent_status: "idle" } } };
      throw new Error(`unexpected ${argv.join(" ")}`);
    } } as unknown as HerdrCli;
    const result = await createLaunchTool({ cli, context: { workspaceId: "w", tabId: "w:t", paneId: "w:p" }, cwd: "/repo", profiles: { load: async () => ({ effective: new Map([[worker.name, worker]]), candidates: [], diagnostics: [] }) } }).execute("id", { name: "worker", profile: "worker" } as never, new AbortController().signal, undefined, { cwd: "/repo" } as never);
    expect(calls).toContainEqual(["agent", "start", "worker", "--kind", "pi", "--pane", "w:p2", "--timeout", "30000", "--", "--model", "test/model", "--thinking", "low", "--append-system-prompt", "\nBody for worker.\n"]);
    expect(result.details).toMatchObject({ profile: { name: "worker", fallbackNames: [] }, kind: "pi" });
  });

  it("inspects profile collections and exact profiles without Herdr reads", async () => {
    const root = "/tmp/profile-scope";
    const worker = parseProfile(profileText("worker"), source(root, "worker"));
    const catalog = { effective: new Map([[worker.name, worker]]), candidates: [{ name: worker.name, profile: worker, source: worker.source }], diagnostics: [] };
    const tool = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => catalog } });
    const collection = await tool.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never);
    expect(collection.details).toMatchObject({ kind: "collection", collection: "profiles", items: [{ name: "worker", kind: "pi" }] });
    const exact = await tool.execute("id", { mode: "profile", profile: "worker" } as never, new AbortController().signal, undefined, {} as never);
    expect(exact.details).toMatchObject({ kind: "profile", profile: { name: "worker", body: expect.stringContaining("Body") } });
  });
});
