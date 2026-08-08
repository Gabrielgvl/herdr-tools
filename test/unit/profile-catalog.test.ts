import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildClaudeArgv, buildPiArgv, buildProfileArgv, discoverProfiles, normalizeScopedResourcePath, parseProfile, profileCatalog, profileSource, readProfileText, resolveProfile, ProfileParseError, ProfileResolutionError, MAX_PROFILE_BYTES, type ProfileReadIo } from "../../src/profiles/index.js";
import { createInspectTool, fitInspectionValue } from "../../src/tools/inspect.js";
import { createLaunchTool, validateLaunchParams } from "../../src/tools/launch.js";
import { createRuntime } from "../../index.js";
import type { HerdrCli } from "../../src/cli.js";

function source(root: string, name: string) { return profileSource("project", join(root, `${name}.md`), root); }
function profileText(name: string, runtime = "pi", extra = "", fallbackProfiles = "[]") {
  const block = runtime === "pi"
    ? "  kind: pi\n  model: test/model\n  thinking: low"
    : "  kind: claude\n  model: claude-test\n  effort: medium";
  const sessionPersistence = runtime === "claude" ? "true" : "false";
  return `---\nname: ${name}\ndescription: Test ${name}\ntimeoutMinutes: 30\nsessionPersistence: ${sessionPersistence}\nruntime:\n${block}\nfallbackProfiles: ${fallbackProfiles}\n${extra}---\n\nBody for ${name}.\n`;
}

const noCli = { runJson: async () => { throw new Error("CLI must not be called"); }, runText: async () => { throw new Error("CLI must not be called"); } } as unknown as HerdrCli;

describe("profile catalog", () => {
  it("fits inspection values without invalid JSON or losing protected evidence", () => {
    const shared = { repeated: true };
    expect(fitInspectionValue(undefined, 128)).toBeUndefined();
    expect(fitInspectionValue("x".repeat(2_000), 128)).toMatchObject({ truncated: true });
    expect(fitInspectionValue(Array.from({ length: 256 }, (_, index) => index), 128)).toBeDefined();
    const stringFit = fitInspectionValue({ message: "x".repeat(2_000) }, 128);
    expect(Buffer.byteLength(JSON.stringify(stringFit), "utf8")).toBeLessThanOrEqual(128);
    const arrayStringFit = fitInspectionValue({ items: ["x".repeat(2_000)] }, 128);
    expect(fitInspectionValue({ empty: "", items: Array.from({ length: 256 }, (_, index) => index) }, 128)).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(arrayStringFit), "utf8")).toBeLessThanOrEqual(128);
    const arrayFit = fitInspectionValue({ items: Array.from({ length: 256 }, (_, index) => index), otherItems: [1, 2], sharedA: shared, sharedB: shared }, 128);
    expect(Buffer.byteLength(JSON.stringify(arrayFit), "utf8")).toBeLessThanOrEqual(128);
    const objectFit = fitInspectionValue({ nested: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`key-${index}`, index])) }, 128);
    expect(Buffer.byteLength(JSON.stringify(objectFit), "utf8")).toBeLessThanOrEqual(128);
    const fallback = fitInspectionValue({ profile: {}, diagnostics: Array.from({ length: 256 }, (_, index) => index) }, 1);
    expect(fallback).toMatchObject({ truncated: true, diagnostics: expect.any(Array) });
    expect(fitInspectionValue({ cannotClone: () => undefined }, 128)).toMatchObject({ truncated: true });
  });
  it("parses strict YAML, typed runtime defaults, and profile metadata", () => {
    const root = "/tmp/profile-scope";
    const parsed = parseProfile(profileText("worker"), source(root, "worker"));
    expect(parsed).toMatchObject({ name: "worker", timeoutMinutes: 30, sessionPersistence: false, fallbackProfiles: [], runtime: { kind: "pi", thinking: "low" } });
    expect(parsed.body).toContain("Body for worker");
    const claude = parseProfile(profileText("reviewer", "claude"), source(root, "reviewer"));
    expect(claude.runtime).toMatchObject({ kind: "claude", effort: "medium", permissionMode: "default" });
    expect(claude.sessionPersistence).toBe(true);
    expect(() => parseProfile(profileText("claude-disabled", "claude").replace("sessionPersistence: true", "sessionPersistence: false"), source(root, "claude-disabled"))).toThrow(ProfileParseError);
    const resources = parseProfile(profileText("worker").replace("thinking: low", "thinking: low\n  tools: [read]\n  extensions: [./ext.ts]\n  skills: [./skills]"), source(root, "worker"));
    expect(resources.runtime).toMatchObject({ tools: ["read"], extensions: [join(root, "ext.ts")], skills: [join(root, "skills")] });
    expect(buildProfileArgv(resources, { extensions: ["./override.ts"], skills: ["./override-skills"] })).toContain(join(root, "override.ts"));
    expect(buildProfileArgv(resources, { extensions: ["./override.ts"], skills: ["./override-skills"] })).toContain(join(root, "override-skills"));
    expect(() => normalizeScopedResourcePath("", "resource", root)).toThrow(ProfileParseError);
    for (const path of ["/tmp/absolute.ts", "../outside.ts", "./nested//unsafe.ts", "C:\\outside.ts"]) {
      expect(() => parseProfile(profileText("worker").replace("thinking: low", `thinking: low\n  extensions: [${JSON.stringify(path)}]`), source(root, "worker"))).toThrow(ProfileParseError);
      expect(() => buildProfileArgv(resources, { extensions: [path] })).toThrow();
    }
    expect(buildProfileArgv(resources, {}, "/tmp/prompt")).toEqual(["--model", "test/model", "--thinking", "low", "--tools", "read", "--extension", join(root, "ext.ts"), "--skill", join(root, "skills"), "--no-session", "--append-system-prompt", "/tmp/prompt"]);
    const claudeResources = parseProfile(profileText("claude-resource", "claude").replace("effort: medium", "effort: medium\n  permissionMode: acceptEdits\n  allowedTools: [Read]\n  disallowedTools: [Bash]\n  addDirs: [./docs]\n  pluginDirs: [./plugin]"), source(root, "claude-resource"));
    expect(buildProfileArgv(claudeResources, {}, "/tmp/prompt")).toEqual(["--model", "claude-test", "--effort", "medium", "--permission-mode", "acceptEdits", "--allowed-tools", "Read", "--disallowed-tools", "Bash", "--add-dir", join(root, "docs"), "--plugin-dir", join(root, "plugin"), "--append-system-prompt-file", "/tmp/prompt"]);
  });

  it("rejects malformed frontmatter and unknown or invalid fields", () => {
    const root = "/tmp/profile-scope";
    const cases = [
      "plain markdown",
      "---\nname: x\n",
      "---\n- x\n---\n\nbody\n",
      "---\nname: [\n---\n\nbody\n",
      profileText("worker").replace(/runtime:\n {2}kind: pi\n {2}model: test\/model\n {2}thinking: low\n/, "runtime: null\n"),
      profileText("worker").replace(/runtime:\n {2}kind: pi\n {2}model: test\/model\n {2}thinking: low\n/, "runtime:\n"),
      profileText("worker").replace("kind: pi", "kind: other"),
      profileText("worker").replace("thinking: low", "thinking: invalid"),
      profileText("worker").replace("model: test/model", "model:"),
      profileText("worker", "claude").replace("effort: medium", "effort: invalid"),
      profileText("worker", "claude").replace("effort: medium", "effort: medium\n  permissionMode: invalid"),
      profileText("worker").replace("thinking: low", "thinking: low\n  unknown: []"),
      profileText("worker").replace("thinking: low", "thinking: low\n  tools: not-an-array"),

      profileText("worker").replace("timeoutMinutes: 30", "timeoutMinutes: 0"),
      profileText("worker").replace("sessionPersistence: false", "sessionPersistence: yes"),
      profileText("worker").replace("fallbackProfiles: []", "fallbackProfiles: worker"),
      profileText("worker").replace("fallbackProfiles: []", "fallbackProfiles: [worker, worker]"),
      profileText("worker").replace("fallbackProfiles: []", "fallbackProfiles: [worker, \"\"]"),
      profileText("worker").replace("fallbackProfiles: []", "fallbackProfiles: [BadName]"),
      profileText("worker").replace("description: Test worker", "description: !custom Test worker"),
      profileText("worker").replace("description: Test worker", "description: !!str Test worker"),
      profileText("worker").replace("description: Test worker", "description: &1 Test worker"),
      profileText("worker").replace("description: Test worker", "description: *1 Test worker"),
      profileText("worker").replace("description: Test worker", "description: !1 Test worker"),
      profileText("worker").replace("description: Test worker", "description: !!int Test worker"),
      profileText("worker").replace("description: Test worker", "description: !<tag:yaml.org,2002:str> Test worker"),
      profileText("worker").replace("description: Test worker", "description: &desc Test worker\nextraDescription: *desc"),
      profileText("worker").replace("thinking: low", "thinking: low\n  extensions: &paths [./ext]\n  skills: *paths"),
      profileText("worker").replace("runtime:\n", "runtime:\n  extra: true\n"),
      profileText("Worker"),
    ];
    for (const [index, text] of cases.entries()) expect(() => parseProfile(text, source(root, "worker")), `case ${index}`).toThrow(ProfileParseError);
    expect(parseProfile(profileText("worker").replace("description: Test worker", 'description: "ordinary ! & * text"'), source(root, "worker")).description).toBe("ordinary ! & * text");
    expect(parseProfile(profileText("worker").replace("fallbackProfiles: []\n", ""), source(root, "worker")).fallbackProfiles).toEqual([]);
    expect(() => parseProfile(profileText("worker"), source(root, "other"))).toThrow(ProfileParseError);
    expect(() => parseProfile(profileText("worker").replace("\nBody for worker.\n", "\n   \n"), source(root, "worker"))).toThrow(ProfileParseError);
    expect(() => parseProfile(profileText("worker").replace("\nBody for worker.\n", "\nbody\0body\n"), source(root, "worker"))).toThrow(ProfileParseError);
    expect(() => parseProfile(profileText("worker").replace("\nBody for worker.\n", `\n${"x".repeat(33_000)}\n`), source(root, "worker"))).toThrow(ProfileParseError);
    expect(() => parseProfile(profileText("worker") + "x".repeat(66_000), source(root, "worker"))).toThrow(ProfileParseError);
  });

  it("discovers scoped precedence, reports shadows, and blocks invalid overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-profile-"));
    const bundled = join(root, "package", "herdr-profiles");
    const user = join(root, "home", ".pi", "agent", "herdr-profiles");
    const project = join(root, "project", ".pi", "herdr-profiles");
    await Promise.all([mkdir(bundled, { recursive: true }), mkdir(user, { recursive: true }), mkdir(project, { recursive: true })]);
    await writeFile(join(bundled, "worker.md"), profileText("worker"));
    await writeFile(join(user, "worker.md"), profileText("worker", "claude"));
    await writeFile(join(project, "worker.md"), profileText("worker"));
    await writeFile(join(project, "blocked.md"), "---\nname: blocked\ndescription: invalid\ntimeoutMinutes: 30\nsessionPersistence: false\nruntime:\n  kind: pi\n  model: x\n  thinking: invalid\nfallbackProfiles: []\n---\n\nbody\n");
    await writeFile(join(bundled, "blocked.md"), profileText("blocked"));
    const catalog = await discoverProfiles({ bundledDir: bundled, bundledScopeRoot: join(root, "package"), userDir: user, userScopeRoot: join(root, "home", ".pi", "agent"), projectDir: project, projectRoot: join(root, "project") });
    expect(catalog.effective.get("worker")?.source.scopeRoot).toBe(join(root, "project"));
    expect(catalog.effective.has("blocked")).toBe(false);
    expect(catalog.blocked?.has("blocked")).toBe(true);
    expect(catalog.diagnostics.some((item) => item.code === "SHADOWED_PROFILE")).toBe(true);
    expect(catalog.diagnostics.some((item) => item.code === "BLOCKED_PROFILE")).toBe(true);
  });

  it("isolates unrelated invalid files and finds the nearest project scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-profile-empty-"));
    const nested = join(root, "a", "b");
    await mkdir(join(root, ".pi", "herdr-profiles"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, ".pi", "herdr-profiles", "worker.md"), profileText("worker"));
    const catalog = await discoverProfiles({ bundledDir: join(root, "missing-bundled"), userDir: join(root, "missing-user"), projectCwd: nested });
    expect(catalog.effective.get("worker")?.source.scopeRoot).toBe(root);
    const invalidDirectory = join(root, "not-a-directory");
    await writeFile(invalidDirectory, "file");
    const withDiscoveryError = await discoverProfiles({ bundledDir: invalidDirectory, userDir: join(root, "missing-user") });
    expect(withDiscoveryError.diagnostics.some((item) => item.code === "DISCOVERY_ERROR")).toBe(true);
    const lowerScope = join(root, "lower-scope");
    const unreadableProject = join(root, "unreadable-project");
    await mkdir(lowerScope, { recursive: true });
    await writeFile(join(lowerScope, "worker.md"), profileText("worker"));
    await writeFile(unreadableProject, "not-a-directory");
    const unreadableCatalog = await discoverProfiles({ bundledDir: lowerScope, userDir: join(root, "missing-user"), projectDir: unreadableProject });
    expect(unreadableCatalog.unreadableScopes).toEqual(["project"]);
    expect(() => resolveProfile("worker", unreadableCatalog)).toThrow(/unreadable project/);
    const fileProject = join(root, "file-project");
    await mkdir(fileProject, { recursive: true });
    await mkdir(join(fileProject, ".pi"), { recursive: true });
    await writeFile(join(fileProject, ".pi", "herdr-profiles"), "not-a-directory");
    expect((await discoverProfiles({ bundledDir: join(root, "missing-bundled"), userDir: join(root, "missing-user"), projectCwd: fileProject })).effective.size).toBe(1);
    const fileProjectCatalog = await discoverProfiles({ bundledDir: join(root, "missing-bundled"), userDir: join(root, "missing-user"), projectCwd: join(fileProject, ".pi", "herdr-profiles", "nested") });
    expect(fileProjectCatalog.unreadableScopes).toEqual(["project"]);
    expect(fileProjectCatalog.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DISCOVERY_ERROR" })]));
    const lowerInvalid = join(root, "lower-invalid");
    const higherValid = join(root, "higher-valid");
    await mkdir(lowerInvalid, { recursive: true });
    await mkdir(higherValid, { recursive: true });
    await writeFile(join(lowerInvalid, "same.md"), "bad");
    await writeFile(join(higherValid, "same.md"), profileText("same"));
    const lowerHigher = await discoverProfiles({ bundledDir: lowerInvalid, userDir: higherValid });
    expect(lowerHigher.effective.has("same")).toBe(true);
    const oversized = join(root, "oversized");
    await mkdir(oversized, { recursive: true });
    await writeFile(join(oversized, "too-large.md"), "x".repeat(70_000));
    const oversizedCatalog = await discoverProfiles({ bundledDir: oversized, userDir: join(root, "missing-user") });
    expect(oversizedCatalog.candidates[0]?.diagnostic?.message).toContain("exceeds");
    const growingReader: ProfileReadIo = {
      stat: vi.fn(async () => ({ size: MAX_PROFILE_BYTES - 1 })),
      open: vi.fn(async () => ({
        read: async (buffer: Buffer, offset: number, length: number) => { buffer.fill(120, offset, offset + length); return { bytesRead: length }; },
        stat: async () => ({ size: MAX_PROFILE_BYTES + 1 }),
        close: vi.fn(async () => undefined)
      }))
    };
    await expect(readProfileText("growing.md", growingReader)).rejects.toThrow(/exceeds/);
    const postReadGrowing: ProfileReadIo = {
      stat: vi.fn(async () => ({ size: MAX_PROFILE_BYTES })),
      open: vi.fn(async () => ({
        read: async (buffer: Buffer, offset: number, length: number) => { buffer.fill(120, offset, offset + Math.min(length, MAX_PROFILE_BYTES - offset)); return { bytesRead: Math.min(length, MAX_PROFILE_BYTES - offset) }; },
        stat: async () => ({ size: MAX_PROFILE_BYTES + 1 }),
        close: vi.fn(async () => undefined)
      }))
    };
    await expect(readProfileText("post-read-growing.md", postReadGrowing)).rejects.toThrow(/exceeds/);
    const manyInvalid = join(root, "many-invalid");
    await mkdir(manyInvalid, { recursive: true });
    await Promise.all(Array.from({ length: 33 }, (_, index) => writeFile(join(manyInvalid, `bad-${index}.md`), "bad")));
    const bounded = await discoverProfiles({ bundledDir: manyInvalid, userDir: join(root, "missing-user") });
    expect(bounded.diagnostics.length).toBe(32);
    expect(await profileCatalog({ bundledDir: join(root, "missing-bundled") })()).toMatchObject({ effective: expect.any(Map) });
    const permissionCatalog = await discoverProfiles({ bundledDir: lowerScope, userDir: join(root, "missing-user"), projectCwd: nested, projectStat: async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); } });
    expect(permissionCatalog.unreadableScopes).toEqual(["project"]);
    expect(permissionCatalog.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DISCOVERY_ERROR", path: join(root, "a", "b", ".pi", "herdr-profiles") })]));
    expect(() => resolveProfile("worker", permissionCatalog)).toThrow(/unreadable project/);
  });

  it("validates reachable fallback graphs and max attempts", () => {
    const root = "/tmp/profile-scope";
    const make = (name: string, fallbacks: string[]) => parseProfile(profileText(name, "pi", "", JSON.stringify(fallbacks)), source(root, name));
    const effective = new Map([make("root", ["next"]), make("next", ["last"]), make("last", [])].map((item) => [item.name, item] as const));
    const resolution = resolveProfile("root", { effective, candidates: [], diagnostics: [] });
    expect(resolution.reachableNames).toEqual(["root", "next", "last"]);
    expect(resolution.fallbackProfiles).toEqual(["next"]);
    const missing = make("root", ["missing"]);
    expect(() => resolveProfile("root", { effective: new Map([[missing.name, missing]]), candidates: [], diagnostics: [] })).toThrow(ProfileResolutionError);
    const cycle = new Map([make("root", ["next"]), make("next", ["root"])].map((item) => [item.name, item] as const));
    expect(() => resolveProfile("root", { effective: cycle, candidates: [], diagnostics: [] })).toThrow(ProfileResolutionError);
    expect(() => resolveProfile("bad_name", { effective, candidates: [], diagnostics: [] })).toThrow(ProfileResolutionError);
    expect(() => resolveProfile("root", { effective, candidates: [], diagnostics: [] }, 0)).toThrow(ProfileResolutionError);
    const tooDeep = new Map([make("root", ["next"]), make("next", ["last"]), make("last", ["end"]), make("end", [])].map((item) => [item.name, item] as const));
    expect(() => resolveProfile("root", { effective: tooDeep, candidates: [], diagnostics: [] }, 3)).toThrow(ProfileResolutionError);
    expect(() => resolveProfile("missing", { effective, candidates: [], diagnostics: [] })).toThrow(ProfileResolutionError);
    const shared = new Map([make("root", ["next", "last"]), make("next", ["last"]), make("last", [])].map((item) => [item.name, item] as const));
    expect(resolveProfile("root", { effective: shared, candidates: [], diagnostics: [] }).reachableNames).toEqual(["root", "next", "last"]);
    const fanout = new Map([make("root", ["next", "last", "end"]), make("next", []), make("last", []), make("end", [])].map((item) => [item.name, item] as const));
    expect(() => resolveProfile("root", { effective: fanout, candidates: [], diagnostics: [] })).toThrow(ProfileResolutionError);
    expect(() => resolveProfile("blocked", { effective, blocked: new Set(["blocked"]), candidates: [], diagnostics: [] })).toThrow(/blocked/);
  });

  it("builds only typed Pi and Claude flags", () => {
    const pi = parseProfile(profileText("worker"), source("/tmp/profile-scope", "worker"));
    const claude = parseProfile(profileText("reviewer", "claude"), source("/tmp/profile-scope", "reviewer"));
    expect(buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, pi.sessionPersistence, { model: "override/model", thinking: "high" }, "system prompt")).toEqual(["--model", "override/model", "--thinking", "high", "--no-session", "--append-system-prompt", "system prompt"]);
    expect(buildClaudeArgv(claude.runtime as Extract<typeof claude.runtime, { kind: "claude" }>, claude.sessionPersistence, {}, "system prompt")).toEqual(["--model", "claude-test", "--effort", "medium", "--permission-mode", "default", "--append-system-prompt-file", "system prompt"]);
    expect(buildClaudeArgv(claude.runtime as Extract<typeof claude.runtime, { kind: "claude" }>, true)).toEqual(["--model", "claude-test", "--effort", "medium", "--permission-mode", "default"]);
    expect(buildProfileArgv(claude)).not.toContain("--no-session-persistence");
    expect(buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, pi.sessionPersistence)).toEqual(["--model", "test/model", "--thinking", "low", "--no-session"]);
    const persisted = { ...pi, sessionPersistence: true };
    expect(buildProfileArgv(persisted)).not.toContain("--no-session");
    expect(() => buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, pi.sessionPersistence, { model: "bad\nmodel" })).toThrow();
    expect(() => buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, pi.sessionPersistence, {}, "bad\npath")).toThrow();
    expect(() => buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, pi.sessionPersistence, { thinking: "invalid" as never })).toThrow();
    expect(() => buildClaudeArgv(claude.runtime as Extract<typeof claude.runtime, { kind: "claude" }>, claude.sessionPersistence, { effort: "invalid" as never })).toThrow();
    expect(() => buildClaudeArgv(claude.runtime as Extract<typeof claude.runtime, { kind: "claude" }>, claude.sessionPersistence, { permissionMode: "invalid" as never })).toThrow();
    expect(buildClaudeArgv(claude.runtime as Extract<typeof claude.runtime, { kind: "claude" }>, claude.sessionPersistence, { permissionMode: "bypassPermissions" })).toContain("--allow-dangerously-skip-permissions");
    expect(() => buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, pi.sessionPersistence, { tools: ["bad\nvalue"] })).toThrow();
    expect(() => buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, pi.sessionPersistence, { extensions: ["./extension"] })).toThrow(/scope root/);
    expect(() => buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, pi.sessionPersistence, { extensions: ["../outside"] }, undefined, "/tmp/profile-scope")).toThrow();
    for (const key of ["effort", "permissionMode", "allowedTools", "disallowedTools", "addDirs", "pluginDirs"] as const) expect(() => buildProfileArgv(pi, { [key]: key === "permissionMode" ? "plan" : key === "effort" ? "low" : ["value"] } as never)).toThrow();
    for (const key of ["thinking", "tools", "extensions", "skills"] as const) expect(() => buildProfileArgv(claude, { [key]: key === "thinking" ? "low" : ["value"] } as never)).toThrow();
  });

  it("validates profile launch input before placement", () => {
    const invalid = [
      { name: "worker" }, { name: "worker", kind: "pi", profile: "worker" }, { name: "worker", profile: "" },
      { name: "worker", profile: "worker", argv: [] }, { name: "worker", profile: "worker", env: {} },
      { name: "worker", profile: "worker", overrides: null }, { name: "worker", profile: "worker", overrides: { unknown: "x" } },
      { name: "worker", profile: "worker", overrides: { model: "" } }, { name: "worker", profile: "worker", overrides: { tools: ["bad\nvalue"] } }, { name: "worker", kind: "pi", overrides: {} }
    ];
    for (const value of invalid) expect(() => validateLaunchParams(value as never)).toThrow();
    expect(() => validateLaunchParams({ name: "worker", profile: "worker", overrides: { thinking: "low", tools: ["read"], extensions: ["./ext"], skills: ["./skill"], allowedTools: ["Read"], disallowedTools: ["Bash"], addDirs: ["."], pluginDirs: ["./plugin"] } } as never)).not.toThrow();
  });

  it("launches a resolved profile through the existing placement path", async () => {
    const root = "/tmp/profile-scope";
    const worker = parseProfile(profileText("worker"), source(root, "worker"));
    const calls: string[][] = [];
    const snapshot = { type: "session_snapshot", snapshot: { version: "0.8", protocol: 1, workspaces: [{ workspace_id: "w", label: "workspace" }], tabs: [{ tab_id: "w:t", workspace_id: "w", label: "main" }], panes: [{ pane_id: "w:p", tab_id: "w:t", workspace_id: "w", label: "caller", agent_status: "idle" }], agents: [] } };
    const cleanup = vi.fn(async () => undefined);
    const promptFiles = { create: vi.fn(async (body: string) => ({ path: "/tmp/profile-prompt", cleanup, body })) };
    const cli = { runJson: async (argv: string[]) => {
      calls.push(argv);
      if (argv[0] === "api") return { id: "snapshot", result: snapshot };
      if (argv[0] === "pane" && argv[1] === "split") return { id: "split", result: { pane: { pane_id: "w:p2", tab_id: "w:t" } } };
      if (argv[0] === "pane" && argv[1] === "rename") return { id: "rename", result: {} };
      if (argv[0] === "agent" && argv[1] === "start") return { id: "start", result: { agent: { name: "worker", agent_id: "a" } } };
      if (argv[0] === "pane" && argv[1] === "get") return { id: "get", result: { pane: { pane_id: "w:p2", tab_id: "w:t", agent_name: "worker", agent_status: "idle" } } };
      throw new Error(`unexpected ${argv.join(" ")}`);
    } } as unknown as HerdrCli;
    const result = await createLaunchTool({ cli, context: { workspaceId: "w", tabId: "w:t", paneId: "w:p" }, cwd: "/repo", promptFiles, profiles: { load: async () => ({ effective: new Map([[worker.name, worker]]), candidates: [], diagnostics: [] }) } }).execute("id", { name: "worker", profile: "worker" } as never, new AbortController().signal, undefined, { cwd: "/repo" } as never);
    expect(promptFiles.create).toHaveBeenCalledWith("\nBody for worker.\n");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(calls).toContainEqual(["agent", "start", "worker", "--kind", "pi", "--pane", "w:p2", "--timeout", "120000", "--", "--model", "test/model", "--thinking", "low", "--no-session", "--append-system-prompt", "/tmp/profile-prompt"]);
    expect(result.details).toMatchObject({ profile: { name: "worker", fallbackProfiles: [], timeoutMinutes: 30 }, kind: "pi" });
  });

  it("inspects bounded profile collections and exact profiles without Herdr reads", async () => {
    const root = "/tmp/profile-scope";
    const worker = parseProfile(profileText("worker"), source(root, "worker"));
    const claudeBase = parseProfile(profileText("claude", "claude"), source(root, "claude"));
    const claude = { ...claudeBase, runtime: { ...claudeBase.runtime, allowedTools: ["Read"], disallowedTools: ["Bash"], addDirs: ["/docs"], pluginDirs: ["/plugin"] } };
    const longBody = { ...worker, name: "long", source: source(root, "long"), body: "x".repeat(9_000) };
    const hugeMetadata = { ...worker, name: "huge", source: source(root, "huge"), description: "d".repeat(100_000) };
    const fallbackRoot = { ...worker, name: "fallback-root", source: source(root, "fallback-root"), fallbackProfiles: [worker.name] };
    const catalog = { effective: new Map([[worker.name, worker], [longBody.name, longBody], [hugeMetadata.name, hugeMetadata], [fallbackRoot.name, fallbackRoot], [claude.name, claude]]), blocked: new Set(["blocked-no-diagnostic"]), candidates: [{ name: worker.name, profile: worker, source: worker.source }, { name: hugeMetadata.name, profile: hugeMetadata, source: hugeMetadata.source }, { name: fallbackRoot.name, profile: fallbackRoot, source: fallbackRoot.source }, { name: claude.name, profile: claude, source: claude.source }, { name: "invalid", source: source(root, "invalid"), diagnostic: { code: "INVALID_PROFILE" as const, message: "bad" } }, { name: "invalid", source: source(root, "invalid-2"), diagnostic: { code: "INVALID_PROFILE" as const, message: "bad again" } }, { name: "blocked-no-diagnostic", source: source(root, "blocked-no-diagnostic") }, { name: "no-diagnostic", source: source(root, "no-diagnostic") }], diagnostics: [{ code: "SHADOWED_PROFILE" as const, message: "test", name: "worker", path: "/tmp/shadowed" }, { code: "DISCOVERY_ERROR" as const, message: "scope read failed", path: "/tmp/unreadable" }] };
    const tool = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => catalog } });
    const contentText = (result: { content: Array<unknown> }) => (result.content[0] as { text: string }).text;
    const collection = await tool.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never);
    expect(collection.details).toMatchObject({ kind: "collection", collection: "profiles", items: expect.arrayContaining([expect.objectContaining({ name: "worker", kind: "pi" }), expect.objectContaining({ name: "claude", effort: "medium" })]) });
    expect(contentText(collection)).toContain('"description":"Test worker"');
    expect(contentText(collection)).toContain('"thinking":"low"');
    expect(contentText(collection)).toContain('"source"');
    const exact = await tool.execute("id", { mode: "profile", profile: "worker" } as never, new AbortController().signal, undefined, {} as never);
    expect(exact.details).toMatchObject({ kind: "profile", profile: { name: "worker", body: expect.stringContaining("Body") } });
    expect(contentText(exact)).toContain('"body":"\\nBody for worker.\\n"');
    const exactClaude = await tool.execute("id", { mode: "profile", profile: "claude" } as never, new AbortController().signal, undefined, {} as never);
    expect(contentText(exactClaude)).toContain('"effort":"medium"');
    const fallback = await tool.execute("id", { mode: "profile", profile: "fallback-root" } as never, new AbortController().signal, undefined, {} as never);
    expect(contentText(fallback)).toContain('"fallbackProfiles":["worker"]');
    const long = await tool.execute("id", { mode: "profile", profile: "long" } as never, new AbortController().signal, undefined, {} as never);
    expect(long.details).toMatchObject({ profile: { body: expect.stringContaining("profile body truncated") } });
    const huge = await tool.execute("id", { mode: "profile", profile: "huge" } as never, new AbortController().signal, undefined, {} as never);
    expect(Buffer.byteLength(JSON.stringify(huge.details), "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(Buffer.byteLength(contentText(huge), "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(() => JSON.parse(contentText(huge))).not.toThrow();
    expect(Buffer.byteLength(contentText(collection), "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(() => JSON.parse(contentText(collection))).not.toThrow();
    const manyProfiles = Array.from({ length: 100 }, (_, index) => ({
      ...worker,
      name: `profile-${index}`,
      description: "d".repeat(512),
      fallbackProfiles: Array.from({ length: 16 }, (_, fallback) => `fallback-${fallback}-${"x".repeat(100)}`),
      source: profileSource("bundled", "p".repeat(512), "s".repeat(512))
    }));
    const boundedTool = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => ({ effective: new Map(manyProfiles.map((item) => [item.name, item])), candidates: manyProfiles.map((item) => ({ name: item.name, profile: item, source: item.source })), diagnostics: Array.from({ length: 16 }, (_, index) => ({ code: "DISCOVERY_ERROR" as const, name: `diagnostic-${index}`, message: "m".repeat(512), path: "p".repeat(512) })) }) } });
    const boundedCollection = await boundedTool.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never);
    expect(Buffer.byteLength(contentText(boundedCollection), "utf8")).toBeLessThanOrEqual(50 * 1024);
    const blockedProfile = { ...worker, name: "blocked-low", source: profileSource("bundled", "/tmp/blocked-low.md", "/tmp") };
    const blockedCatalog = { ...catalog, effective: new Map([[blockedProfile.name, blockedProfile]]), candidates: [{ name: blockedProfile.name, profile: blockedProfile, source: blockedProfile.source }], unreadableScopes: ["project"] as const };
    const blockedTool = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => blockedCatalog } });
    const blockedCollection = await blockedTool.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never);
    expect(JSON.stringify(blockedCollection.details)).toContain("unreadable higher-precedence");
    await expect(tool.execute("id", { mode: "collection", collection: "profiles", profile: "worker" } as never, new AbortController().signal, undefined, {} as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(tool.execute("id", { mode: "profile", profile: "worker", target: "current" } as never, new AbortController().signal, undefined, {} as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(tool.execute("id", { mode: "profile", profile: "missing" } as never, new AbortController().signal, undefined, {} as never)).rejects.toMatchObject({ code: "PROFILE_RESOLUTION_INVALID" });
    const unavailable = createInspectTool({ cli: noCli, context: {} });
    await expect(unavailable.execute("id", { mode: "profile", profile: "worker" } as never, new AbortController().signal, undefined, {} as never)).rejects.toMatchObject({ code: "PROFILE_CATALOG_UNAVAILABLE" });
  });

  it("keeps profile launch and renderer failures explicit", async () => {
    const launchTool = createLaunchTool({ cli: noCli as never, context: {}, profiles: undefined });
    await expect(launchTool.execute("id", { name: "worker", profile: "worker" } as never, new AbortController().signal, undefined, { cwd: "/repo" } as never)).rejects.toMatchObject({ code: "PROFILE_CATALOG_UNAVAILABLE" });
    const rendered = launchTool.renderCall?.({ name: "worker", profile: "worker" } as never, {} as never, {} as never);
    expect(rendered?.render(80)).toEqual(["herdr_launch · profile · worker"]);
    rendered?.invalidate();
  });

  it("loads bundled profiles from the package scope", async () => {
    const runtime = createRuntime({ exec: async () => { throw new Error("unused"); } }, { HERDR_ENV: "1" });
    const catalog = await runtime.profiles.load();
    expect(catalog.effective.size).toBe(10);
    expect(catalog.effective.get("worker-pi")?.source.scopeRoot).toBe(process.cwd());
  });
});
