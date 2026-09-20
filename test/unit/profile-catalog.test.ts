import { access, mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AGY_MODES, attachmentCapability, buildClaudeArgv, buildPiArgv, buildProfileArgv, discoverProfiles, normalizeScopedResourcePath, parseProfile, profileNameFromPath, profileSource, readProfileText, ProfileParseError, MAX_PROFILE_BYTES, type DevinPermissionMode, type ProfileReadIo } from "../../src/profiles/index.js";
import { createInspectTool, fitInspectionValue } from "../../src/tools/inspect.js";
import { createRuntime } from "../../index.js";

function source(root: string, name: string) { return profileSource("project", join(root, `${name}.md`), root); }
function profileText(name: string, runtime: "pi" | "claude" | "agy" | "devin" = "pi", extra = "", fallbackProfiles = "[]", agyMode: (typeof AGY_MODES)[number] = "plan", devinMode: DevinPermissionMode = "dangerous") {
  const block = runtime === "pi"
    ? "  kind: pi\n  model: test/model\n  thinking: low"
    : runtime === "claude"
      ? "  kind: claude\n  model: claude-test\n  effort: medium"
      : runtime === "devin"
        ? `  kind: devin\n  model: swe-2-max\n  permissionMode: ${devinMode}`
        : `  kind: agy\n  model: gemini-3.8-flash-high\n  mode: ${agyMode}\n  addDirs: []`;
  const sessionPersistence = runtime === "pi" ? "false" : "true";
  return `---\nname: ${name}\ndescription: Test ${name}\ntimeoutMinutes: 30\nsessionPersistence: ${sessionPersistence}\nruntime:\n${block}\nfallbackProfiles: ${fallbackProfiles}\n${extra}---\n\nBody for ${name}.\n`;
}

const noCli = { runJson: async () => { throw new Error("CLI must not be called"); }, runText: async () => { throw new Error("CLI must not be called"); } } as never;

describe("profile catalog", () => {
  it("fits inspection values without invalid JSON or losing protected evidence", () => {
    const shared = { repeated: true };
    expect(fitInspectionValue(undefined, 128)).toBeUndefined();
    expect(fitInspectionValue("x".repeat(2_000), 128)).toMatchObject({ truncated: true, diagnostics: [{ code: "OUTPUT_TRUNCATED" }] });
    expect(fitInspectionValue(Array.from({ length: 256 }, (_, index) => index), 128)).toMatchObject({ truncated: true, diagnostics: [{ code: "OUTPUT_TRUNCATED" }] });
    const stringFit = fitInspectionValue({ message: "x".repeat(2_000) }, 128) as Record<string, unknown>;
    expect(stringFit).toMatchObject({ truncated: true, diagnostics: [{ code: "OUTPUT_TRUNCATED" }] });
    expect(Buffer.byteLength(JSON.stringify(stringFit), "utf8")).toBeLessThanOrEqual(128);
    const successfulObjectFit = fitInspectionValue({ name: "stable-name", message: "x".repeat(2_000) }, 256) as Record<string, unknown>;
    expect(successfulObjectFit).toMatchObject({ name: "stable-name", truncated: true, diagnostics: [{ code: "OUTPUT_TRUNCATED" }] });
    const arrayStringFit = fitInspectionValue({ items: ["x".repeat(2_000)] }, 128) as Record<string, unknown>;
    expect(arrayStringFit).toMatchObject({ truncated: true, diagnostics: [{ code: "OUTPUT_TRUNCATED" }] });
    expect(Buffer.byteLength(JSON.stringify(arrayStringFit), "utf8")).toBeLessThanOrEqual(128);
    expect(fitInspectionValue({ name: "stable-array", items: Array.from({ length: 256 }, (_, index) => index) }, 256)).toMatchObject({ truncated: true, diagnostics: [{ code: "OUTPUT_TRUNCATED" }] });
    expect(fitInspectionValue({ empty: "", items: Array.from({ length: 256 }, (_, index) => index) }, 128)).toMatchObject({ truncated: true });
    const arrayFit = fitInspectionValue({ items: Array.from({ length: 256 }, (_, index) => index), otherItems: [1, 2], sharedA: shared, sharedB: shared }, 128) as Record<string, unknown>;
    expect(arrayFit).toMatchObject({ truncated: true, diagnostics: [{ code: "OUTPUT_TRUNCATED" }] });
    expect(Buffer.byteLength(JSON.stringify(arrayFit), "utf8")).toBeLessThanOrEqual(128);
    const objectFit = fitInspectionValue({ nested: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`key-${index}`, index])) }, 128);
    expect(Buffer.byteLength(JSON.stringify(objectFit), "utf8")).toBeLessThanOrEqual(128);
    const fallback = fitInspectionValue({ profile: {}, diagnostics: Array.from({ length: 256 }, (_, index) => index) }, 128);
    expect(fallback).toMatchObject({ truncated: true, diagnostics: [{ code: "OUTPUT_TRUNCATED" }] });
    const exactLossy = fitInspectionValue({ operation: "inspect", kind: "profile", profile: { name: "exact-profile", body: "x".repeat(2_000) }, diagnostics: [] }, 512) as Record<string, unknown>;
    expect(exactLossy).toMatchObject({ operation: "inspect", kind: "profile", truncated: true, diagnostics: [{ code: "OUTPUT_TRUNCATED" }] });
    expect(Buffer.byteLength(JSON.stringify(exactLossy), "utf8")).toBeLessThanOrEqual(512);
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
    // Resource selection is profile-only, so override attempts are refused
    // rather than silently repointing the role's allowlist.
    expect(() => buildProfileArgv(resources, { extensions: ["./override.ts"] } as never)).toThrow(/profile-only/);
    expect(() => buildProfileArgv(resources, { skills: ["./override-skills"] } as never)).toThrow(/profile-only/);
    expect(() => buildProfileArgv(claude, { pluginDirs: ["./override-plugin"] } as never)).toThrow(/profile-only/);
    expect(() => normalizeScopedResourcePath("", "resource", root)).toThrow(ProfileParseError);
    for (const path of ["/tmp/absolute.ts", "../outside.ts", "./nested//unsafe.ts", "C:\\outside.ts"]) {
      expect(() => parseProfile(profileText("worker").replace("thinking: low", `thinking: low\n  extensions: [${JSON.stringify(path)}]`), source(root, "worker"))).toThrow(ProfileParseError);
      expect(() => buildProfileArgv(resources, { extensions: [path] } as never)).toThrow(/profile-only/);
    }
    expect(buildProfileArgv(resources, {}, "/tmp/prompt")).toEqual(["--model", "test/model", "--thinking", "low", "--tools", "read", "--extension", join(root, "ext.ts"), "--no-skills", "--skill", join(root, "skills"), "--no-session", "--append-system-prompt", "/tmp/prompt"]);
    const claudeResources = parseProfile(profileText("claude-resource", "claude").replace("effort: medium", "effort: medium\n  permissionMode: acceptEdits\n  allowedTools: [Read]\n  disallowedTools: [Bash]\n  addDirs: [./docs]\n  pluginDirs: [./plugin]"), source(root, "claude-resource"));
    expect(buildProfileArgv(claudeResources, {}, "/tmp/prompt")).toEqual(["--model", "claude-test", "--effort", "medium", "--permission-mode", "acceptEdits", "--allowed-tools", "Read", "--disallowed-tools", "Bash", "--add-dir", join(root, "docs"), "--plugin-dir", join(root, "plugin"), "--append-system-prompt-file", "/tmp/prompt"]);
    expect(buildProfileArgv(claudeResources, {}, undefined, "/tmp/message-attachments/key")).toContain("/tmp/message-attachments/key");
    expect(() => buildProfileArgv(claudeResources, {}, undefined, "relative/key")).toThrow(/absolute/);
    expect(() => buildProfileArgv(claudeResources, {}, undefined, "/tmp/bad\npath")).toThrow(/absolute/);
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
      profileText("worker").replace(/runtime:\n {2}kind: pi\n {2}model: test\/model\n {2}thinking: low\n/, "runtime: { model }\n"),
      profileText("worker").replace("kind: pi", "kind: other"),
      profileText("worker").replace("thinking: low", "thinking: invalid"),
      profileText("worker").replace("model: test/model", "model:"),
      profileText("worker", "claude").replace("effort: medium", "effort: invalid"),
      profileText("worker", "claude").replace("effort: medium", "effort: medium\n  permissionMode: invalid"),
      profileText("worker").replace("thinking: low", "thinking: low\n  unknown: []"),
      profileText("worker").replace("thinking: low", "thinking: low\n  tools: not-an-array"),
      profileText("worker", "agy").replace("  mode: plan", "  mode: invalid"),
      profileText("worker", "agy").replace("  mode: plan\n", ""),

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
    expect(profileNameFromPath("/tmp/herdr-profiles/worker.md")).toBe("worker");
    expect(profileNameFromPath("C:\\\\Users\\\\owner\\\\herdr-profiles\\\\worker.md")).toBe("worker");
    const root = await mkdtemp(join(tmpdir(), "herdr-profile-"));
    const bundled = join(root, "package", "herdr-profiles");
    const user = join(root, "home", ".pi", "agent", "herdr-profiles");
    const project = join(root, "project", ".pi", "herdr-profiles");
    await Promise.all([mkdir(bundled, { recursive: true }), mkdir(user, { recursive: true }), mkdir(project, { recursive: true })]);
    await writeFile(join(bundled, "worker.md"), profileText("worker"));
    await writeFile(join(user, "worker.md"), profileText("worker", "claude"));
    await writeFile(join(project, "worker.md"), profileText("worker"));
    await writeFile(join(bundled, "promoter-pi.md"), profileText("promoter-pi"));
    await writeFile(join(project, "promoter-pi.md"), profileText("promoter-pi", "claude"));
    await writeFile(join(project, "blocked.md"), "---\nname: blocked\ndescription: invalid\ntimeoutMinutes: 30\nsessionPersistence: false\nruntime:\n  kind: pi\n  model: x\n  thinking: invalid\nfallbackProfiles: []\n---\n\nbody\n");
    await writeFile(join(bundled, "blocked.md"), profileText("blocked"));
    const catalog = await discoverProfiles({ bundledDir: bundled, bundledScopeRoot: join(root, "package"), userDir: user, userScopeRoot: join(root, "home", ".pi", "agent"), projectDir: project, projectRoot: join(root, "project") });
    expect(catalog.effective.get("worker")?.source.scopeRoot).toBe(join(root, "project"));
    // The bundled-name reservation is gone: a project-scope promoter-pi.md
    // shadows the bundled one like any other name.
    expect(catalog.effective.get("promoter-pi")?.source.kind).toBe("project");
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
    const fileProject = join(root, "file-project");
    await mkdir(fileProject, { recursive: true });
    await mkdir(join(fileProject, ".pi"), { recursive: true });
    await writeFile(join(fileProject, ".pi", "herdr-profiles"), "not-a-directory");
    expect((await discoverProfiles({ bundledDir: join(root, "missing-bundled"), userDir: join(root, "missing-user"), projectCwd: fileProject })).effective.size).toBe(1);
    const fileProjectCatalog = await discoverProfiles({ bundledDir: join(root, "missing-bundled"), userDir: join(root, "missing-user"), projectCwd: join(fileProject, ".pi", "herdr-profiles", "nested") });
    expect(fileProjectCatalog.unreadableScopes).toEqual(["project"]);
    expect(fileProjectCatalog.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DISCOVERY_ERROR", path: join(fileProject, ".pi", "herdr-profiles", "nested", ".pi", "herdr-profiles"), source: expect.objectContaining({ scopeRoot: join(fileProject, ".pi", "herdr-profiles", "nested") }) })]));
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
    expect(bounded.diagnosticCount).toBe(33);
    const boundedInspect = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => bounded } });
    const boundedInspection = await boundedInspect.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never);
    const boundedInspectionContent = JSON.parse((boundedInspection.content[0] as { text: string }).text) as { diagnosticOmittedCount: number; truncated: boolean; diagnostics: unknown[] };
    expect(boundedInspection.details).toMatchObject({ diagnosticOmittedCount: 17, truncated: true });
    expect(boundedInspectionContent).toMatchObject({ diagnosticOmittedCount: 17, truncated: true });
    expect(boundedInspectionContent.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "OUTPUT_TRUNCATED" })]));
    expect(await discoverProfiles({ bundledDir: join(root, "missing-bundled") })).toMatchObject({ effective: expect.any(Map) });
    const statPaths: string[] = [];
    const permissionCatalog = await discoverProfiles({ bundledDir: lowerScope, userDir: join(root, "missing-user"), projectCwd: nested, projectStat: async (path) => {
      statPaths.push(path);
      if (path === join(root, "a", "b", ".pi", "herdr-profiles")) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    } });
    const failedCandidate = join(root, "a", ".pi", "herdr-profiles");
    expect(statPaths).toEqual([join(root, "a", "b", ".pi", "herdr-profiles"), failedCandidate]);
    expect(permissionCatalog.unreadableScopes).toEqual(["project"]);
    expect(permissionCatalog.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DISCOVERY_ERROR", path: failedCandidate, source: expect.objectContaining({ scopeRoot: join(root, "a") }) })]));
  });

  it("builds only typed Pi and Claude flags", () => {
    const pi = parseProfile(profileText("worker"), source("/tmp/profile-scope", "worker"));
    const claude = parseProfile(profileText("reviewer", "claude"), source("/tmp/profile-scope", "reviewer"));
    expect(buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, pi.sessionPersistence, { model: "override/model", thinking: "high" }, "system prompt")).toEqual(["--model", "override/model", "--thinking", "high", "--no-skills", "--no-session", "--append-system-prompt", "system prompt"]);
    expect(buildClaudeArgv(claude.runtime as Extract<typeof claude.runtime, { kind: "claude" }>, claude.sessionPersistence, {}, "system prompt")).toEqual(["--model", "claude-test", "--effort", "medium", "--permission-mode", "default", "--append-system-prompt-file", "system prompt"]);
    expect(buildClaudeArgv(claude.runtime as Extract<typeof claude.runtime, { kind: "claude" }>, true)).toEqual(["--model", "claude-test", "--effort", "medium", "--permission-mode", "default"]);
    expect(buildProfileArgv(claude)).not.toContain("--no-session-persistence");
    expect(buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, pi.sessionPersistence)).toEqual(["--model", "test/model", "--thinking", "low", "--no-skills", "--no-session"]);
    const persisted = { ...pi, sessionPersistence: true };
    expect(buildProfileArgv(persisted)).not.toContain("--no-session");
    expect(() => buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, pi.sessionPersistence, { model: "bad\nmodel" })).toThrow();
    expect(() => buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, pi.sessionPersistence, {}, "bad\npath")).toThrow();
    expect(() => buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, pi.sessionPersistence, { thinking: "invalid" as never })).toThrow();
    expect(() => buildClaudeArgv(claude.runtime as Extract<typeof claude.runtime, { kind: "claude" }>, claude.sessionPersistence, { effort: "invalid" as never })).toThrow();
    expect(() => buildClaudeArgv(claude.runtime as Extract<typeof claude.runtime, { kind: "claude" }>, false)).toThrow(/sessionPersistence/);
    expect(() => buildClaudeArgv(claude.runtime as Extract<typeof claude.runtime, { kind: "claude" }>, claude.sessionPersistence, { permissionMode: "invalid" as never })).toThrow();
    expect(buildClaudeArgv(claude.runtime as Extract<typeof claude.runtime, { kind: "claude" }>, claude.sessionPersistence, { permissionMode: "bypassPermissions" })).toContain("--allow-dangerously-skip-permissions");
    expect(() => buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, pi.sessionPersistence, { tools: ["bad\nvalue"] })).toThrow();
    expect(() => buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, pi.sessionPersistence, { extensions: ["./extension"] } as never)).toThrow(/profile-only/);
    expect(() => buildPiArgv(pi.runtime as Extract<typeof pi.runtime, { kind: "pi" }>, pi.sessionPersistence, { extensions: ["../outside"] } as never)).toThrow(/profile-only/);
    for (const key of ["effort", "permissionMode", "allowedTools", "disallowedTools", "addDirs", "pluginDirs"] as const) expect(() => buildProfileArgv(pi, { [key]: key === "permissionMode" ? "plan" : key === "effort" ? "low" : ["value"] } as never)).toThrow();
    for (const key of ["thinking", "tools", "extensions", "skills"] as const) expect(() => buildProfileArgv(claude, { [key]: key === "thinking" ? "low" : ["value"] } as never)).toThrow();
    // Scoped overrides need a scope root to resolve against; a bare adapter
    // call without one is refused rather than resolved against the process cwd.
    expect(() => buildClaudeArgv(claude.runtime as Extract<typeof claude.runtime, { kind: "claude" }>, claude.sessionPersistence, { addDirs: ["./docs"] })).toThrow(/scope root/);
    // A Claude profile can opt into development channels, which become one
    // variadic flag group ahead of the fixed flags that follow.
    const channeled = parseProfile(profileText("channeled", "claude").replace("effort: medium", "effort: medium\n  developmentChannels: [server:herdr]"), source("/tmp/profile-scope", "channeled"));
    expect(buildProfileArgv(channeled)).toEqual(expect.arrayContaining(["--dangerously-load-development-channels", "server:herdr"]));
  });

  it("parses and adapts strict AGY profiles", () => {
    const root = "/tmp/profile-scope";
    const agy = parseProfile(profileText("researcher", "agy").replace("  addDirs: []", "  addDirs: [./docs]"), source(root, "researcher"));
    expect(agy.runtime).toEqual({ kind: "agy", model: "gemini-3.8-flash-high", mode: "plan", addDirs: [join(root, "docs")] });
    expect(agy.sessionPersistence).toBe(true);
    expect(buildProfileArgv(agy)).toEqual(["--model", "gemini-3.8-flash-high", "--mode", "plan", "--dangerously-skip-permissions", "--add-dir", join(root, "docs"), "--prompt-interactive", "Initialize this interactive session and reply with exactly AGY_READY."]);
    expect(buildProfileArgv(agy, { model: "gemini-override", addDirs: ["./override"] })).toEqual(["--model", "gemini-override", "--mode", "plan", "--dangerously-skip-permissions", "--add-dir", join(root, "override"), "--prompt-interactive", "Initialize this interactive session and reply with exactly AGY_READY."]);
    expect(buildProfileArgv(agy, {}, undefined, "/tmp/message-attachments/key")).toEqual(["--model", "gemini-3.8-flash-high", "--mode", "plan", "--dangerously-skip-permissions", "--add-dir", join(root, "docs"), "--add-dir", "/tmp/message-attachments/key", "--prompt-interactive", "Initialize this interactive session and reply with exactly AGY_READY."]);
    const workerAgy = parseProfile(profileText("worker-agy", "agy", "", "[worker-claude]", "accept-edits"), source(root, "worker-agy"));
    expect(workerAgy.runtime).toMatchObject({ kind: "agy", model: "gemini-3.8-flash-high", mode: "accept-edits" });
    expect(buildProfileArgv(workerAgy)).toEqual(["--model", "gemini-3.8-flash-high", "--mode", "accept-edits", "--dangerously-skip-permissions", "--prompt-interactive", "Initialize this interactive session and reply with exactly AGY_READY."]);
    expect(() => buildProfileArgv(agy, {}, { mode: "accept-edits" } as never)).toThrow(/AGY/);
    expect(() => buildProfileArgv(agy, {}, "/tmp/prompt-source")).toThrow(/prompt source/);
    expect(() => buildProfileArgv({ ...agy, sessionPersistence: false })).toThrow(/sessionPersistence/);
    expect(() => buildProfileArgv(agy, { thinking: "low" } as never)).toThrow(/AGY/);
    expect(() => buildProfileArgv(agy, { addDirs: ["../outside"] })).toThrow(/scope root/);
    expect(() => parseProfile(profileText("researcher", "agy").replace("  addDirs: []", "  addDirs: []\n  mode: plan"), source(root, "researcher"))).toThrow(ProfileParseError);
    expect([...AGY_MODES]).toEqual(["plan", "accept-edits"]);
    expect(() => parseProfile(profileText("researcher", "agy").replace("sessionPersistence: true", "sessionPersistence: false"), source(root, "researcher"))).toThrow(/AGY profiles must set sessionPersistence/);
    expect(attachmentCapability(agy)).toEqual({ kind: "agy", capable: true, reason: "AGY profile can read its granted attachment directory" });
  });

  it("parses and adapts strict Devin profiles", () => {
    const root = "/tmp/profile-scope";
    const devin = parseProfile(profileText("worker-devin", "devin", "", "[worker-agy]"), source(root, "worker-devin"));
    expect(devin.runtime).toEqual({ kind: "devin", model: "swe-2-max", permissionMode: "dangerous" });
    // permissionMode is optional for Devin runtimes and defaults to normal.
    expect(parseProfile(profileText("worker-devin", "devin").replace("\n  permissionMode: dangerous", ""), source(root, "worker-devin")).runtime).toMatchObject({ kind: "devin", permissionMode: "normal" });
    expect(devin.sessionPersistence).toBe(true);
    expect(devin.fallbackProfiles).toEqual(["worker-agy"]);
    expect(buildProfileArgv(devin)).toEqual(["--model", "swe-2-max", "--permission-mode", "dangerous"]);
    expect(buildProfileArgv(devin, { model: "swe-2", permissionMode: "normal" })).toEqual(["--model", "swe-2", "--permission-mode", "normal"]);
    expect(buildProfileArgv(devin, {}, undefined, "/tmp/message-attachments/key")).toEqual(["--model", "swe-2-max", "--permission-mode", "dangerous"]);
    // The Devin body is catalog metadata and its granted attachment directory
    // is read ambiently, so neither produces argv.
    expect(() => buildProfileArgv(devin, {}, "/tmp/prompt-source")).toThrow(/prompt source/);
    expect(() => buildProfileArgv({ ...devin, sessionPersistence: false })).toThrow(/sessionPersistence/);
    for (const key of ["thinking", "tools", "effort", "allowedTools", "disallowedTools", "addDirs", "pluginDirs", "extensions", "skills", "mode"] as const) {
      expect(() => buildProfileArgv(devin, { [key]: key === "thinking" || key === "effort" || key === "mode" ? "low" : ["value"] } as never)).toThrow(/Devin|profile-only/);
    }
    // Claude-only permission values do not become valid Devin overrides.
    expect(() => buildProfileArgv(devin, { permissionMode: "bypassPermissions" } as never)).toThrow(/permission mode/);
    expect(() => parseProfile(profileText("worker-devin", "devin").replace("permissionMode: dangerous", "permissionMode: autonomous"), source(root, "worker-devin"))).toThrow(ProfileParseError);
    expect(() => parseProfile(profileText("worker-devin", "devin").replace("permissionMode: dangerous", "permissionMode: dangerous\n  addDirs: [./docs]"), source(root, "worker-devin"))).toThrow(ProfileParseError);
    expect(() => parseProfile(profileText("worker-devin", "devin").replace("sessionPersistence: true", "sessionPersistence: false"), source(root, "worker-devin"))).toThrow(/Devin profiles must set sessionPersistence/);
    expect(attachmentCapability(devin)).toEqual({ kind: "devin", capable: true, reason: "Devin profile can read its granted attachment directory" });
  });

  it("preserves AGY mode and permission metadata in model-visible profile inspection", async () => {
    const root = "/tmp/profile-scope";
    const agy = parseProfile(profileText("researcher", "agy"), source(root, "researcher"));
    const tool = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => ({
      effective: new Map([[agy.name, agy]]),
      candidates: [{ name: agy.name, profile: agy, source: agy.source }],
      diagnostics: []
    }) } });
    const content = (result: { content: Array<unknown> }) => JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;

    const collection = content(await tool.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never));
    expect((collection.items as Array<Record<string, unknown>>)[0]).toMatchObject({ kind: "agy", mode: "plan", dangerouslySkipPermissions: true });
  });

  it("inspects bounded profile collections without Herdr reads", async () => {
    const root = "/tmp/profile-scope";
    const worker = parseProfile(profileText("worker"), source(root, "worker"));
    const claudeBase = parseProfile(profileText("claude", "claude"), source(root, "claude"));
    const claude = { ...claudeBase, runtime: { ...claudeBase.runtime, allowedTools: ["Read"], disallowedTools: ["Bash"], addDirs: ["/docs"], pluginDirs: ["/plugin"] } };
    const devin = { ...worker, name: "worker-devin", source: source(root, "worker-devin"), runtime: { kind: "devin" as const, model: "swe-2-max", permissionMode: "dangerous" as const }, sessionPersistence: true };
    const longBody = { ...worker, name: "long", source: source(root, "long"), body: "x".repeat(9_000) };
    const hugeMetadata = { ...worker, name: "huge", source: source(root, "huge"), description: "d".repeat(100_000) };
    const fallbackRoot = { ...worker, name: "fallback-root", source: source(root, "fallback-root"), fallbackProfiles: [worker.name] };
    const catalog = { effective: new Map([[worker.name, worker], [longBody.name, longBody], [hugeMetadata.name, hugeMetadata], [fallbackRoot.name, fallbackRoot], [claude.name, claude], [devin.name, devin]]), blocked: new Set(["blocked-no-diagnostic"]), candidates: [{ name: worker.name, profile: worker, source: worker.source }, { name: hugeMetadata.name, profile: hugeMetadata, source: hugeMetadata.source }, { name: fallbackRoot.name, profile: fallbackRoot, source: fallbackRoot.source }, { name: claude.name, profile: claude, source: claude.source }, { name: devin.name, profile: devin, source: devin.source }, { name: "invalid", source: source(root, "invalid"), diagnostic: { code: "INVALID_PROFILE" as const, message: "bad" } }, { name: "invalid", source: source(root, "invalid-2"), diagnostic: { code: "INVALID_PROFILE" as const, message: "bad again" } }, { name: "invalid-no-message", source: source(root, "invalid-no-message"), diagnostic: { code: "INVALID_PROFILE" as const } as never }, { name: "blocked-no-diagnostic", source: source(root, "blocked-no-diagnostic") }, { name: "no-diagnostic", source: source(root, "no-diagnostic") }], diagnostics: [{ code: "SHADOWED_PROFILE" as const, message: "test", name: "worker", path: "/tmp/shadowed" }, { code: "DISCOVERY_ERROR" as const, message: "scope read failed", path: "/tmp/unreadable" }] };
    const tool = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => catalog } });
    const contentText = (result: { content: Array<unknown> }) => (result.content[0] as { text: string }).text;
    const collection = await tool.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never);
    expect(collection.details).toMatchObject({ kind: "collection", collection: "profiles", items: expect.arrayContaining([expect.objectContaining({ name: "worker", kind: "pi" }), expect.objectContaining({ name: "claude", effort: "medium" })]) });
    expect(contentText(collection)).toContain('"description":"Test worker"');
    expect(contentText(collection)).toContain('"thinking":"low"');
    expect(contentText(collection)).toContain('"source"');
    const blockedWorker = { ...worker, source: profileSource("bundled", "/bundled/worker.md", "/bundled") };
    const blockedInspection = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => ({
      effective: new Map(),
      blocked: new Set(["worker"]),
      candidates: [
        { name: "worker", profile: blockedWorker, source: blockedWorker.source },
        { name: "worker", source: profileSource("user", "/user/worker.md", "/user"), diagnostic: { code: "INVALID_PROFILE" as const, message: "user invalid" } },
        { name: "worker", source: profileSource("project", "/project/worker.md", "/project"), diagnostic: { code: "INVALID_PROFILE" as const, message: "project invalid" } }
      ],
      diagnostics: [{ code: "DISCOVERY_ERROR" as const, message: "user scope unreadable", source: profileSource("user", "/user", "/home") }],
      unreadableScopes: ["user"] as const
    }) } });
    const blockedResult = await blockedInspection.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never);
    expect(blockedResult.details).toMatchObject({ items: [expect.objectContaining({ name: "worker", valid: false, source: expect.objectContaining({ path: "/project/worker.md" }), diagnostic: "project invalid" })] });
    const inverseBlockedInspection = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => ({
      effective: new Map([[blockedWorker.name, blockedWorker]]),
      candidates: [
        { name: "worker", profile: blockedWorker, source: blockedWorker.source },
        { name: "worker", source: profileSource("user", "/user/worker.md", "/user"), diagnostic: { code: "INVALID_PROFILE" as const, message: "user invalid" } }
      ],
      diagnostics: [{ code: "DISCOVERY_ERROR" as const, message: "project scope unreadable", source: profileSource("project", "/project", "/project") }],
      unreadableScopes: ["project"] as const
    }) } });
    const inverseBlockedResult = await inverseBlockedInspection.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never);
    expect(inverseBlockedResult.details).toMatchObject({ items: [expect.objectContaining({ name: "worker", valid: false, source: expect.objectContaining({ kind: "project" }), diagnostic: "project scope unreadable" })] });
    const unreadableInspection = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => ({
      effective: new Map([[blockedWorker.name, blockedWorker]]),
      candidates: [{ name: "worker", profile: blockedWorker, source: blockedWorker.source }],
      diagnostics: [
        { code: "DISCOVERY_ERROR" as const, message: "user scope unreadable", source: profileSource("user", "/user", "/home") },
        { code: "DISCOVERY_ERROR" as const, message: "project scope unreadable", source: profileSource("project", "/project", "/project") }
      ], unreadableScopes: ["bundled", "user", "project"] as const
    }) } });
    const unreadableResult = await unreadableInspection.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never);
    expect(unreadableResult.details).toMatchObject({ items: [expect.objectContaining({ name: "worker", valid: false, source: expect.objectContaining({ kind: "project" }), diagnostic: "project scope unreadable" })] });
    const tieInspection = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => ({
      effective: new Map(), candidates: [{ name: "worker", source: profileSource("user", "/user/worker.md", "/user"), diagnostic: { code: "INVALID_PROFILE" as const, message: "user invalid" } }],
      diagnostics: [{ code: "DISCOVERY_ERROR" as const, message: "user unreadable", source: profileSource("user", "/user", "/home") }], unreadableScopes: ["user"] as const
    }) } });
    const tieResult = await tieInspection.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never);
    expect(tieResult.details).toMatchObject({ items: [expect.objectContaining({ source: expect.objectContaining({ kind: "user" }), diagnostic: "user invalid" })] });
    expect(Buffer.byteLength(contentText(collection), "utf8")).toBeLessThanOrEqual(16_000);
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
    const boundedCollectionContent = JSON.parse(contentText(boundedCollection)) as Record<string, unknown>;
    expect(Buffer.byteLength(contentText(boundedCollection), "utf8")).toBeLessThanOrEqual(16_000);
    expect(boundedCollectionContent.truncated).toBe(true);
    expect(boundedCollectionContent.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "OUTPUT_TRUNCATED" })]));
    expect(boundedCollection.details).toMatchObject({ truncated: true, omittedCount: expect.any(Number), diagnostics: expect.arrayContaining([expect.objectContaining({ code: "OUTPUT_TRUNCATED" })]) });
    expect(boundedCollectionContent.omittedCount).toBeGreaterThan(0);
    const capProfiles = Array.from({ length: 101 }, (_, index) => ({ ...worker, name: `cap-${index}`, description: "d", source: profileSource("bundled", `/p/${index}`, "/p") }));
    const capTool = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => ({ effective: new Map(capProfiles.map((item) => [item.name, item])), candidates: capProfiles.map((item) => ({ name: item.name, profile: item, source: item.source })), diagnostics: [] }) } });
    const capResult = await capTool.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never);
    expect(capResult.details).toMatchObject({ truncated: true, omittedCount: 1 });
    const modelProfiles = Array.from({ length: 30 }, (_, index) => ({ ...worker, name: `model-${index}`, description: "d".repeat(512), source: profileSource("bundled", `/model/${index}`, "/model") }));
    const modelTool = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => ({ effective: new Map(modelProfiles.map((item) => [item.name, item])), candidates: modelProfiles.map((item) => ({ name: item.name, profile: item, source: item.source })), diagnostics: [] }) } });
    const modelCollection = await modelTool.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never);
    const modelContent = JSON.parse(contentText(modelCollection)) as { collection: string; items: Array<Record<string, unknown>>; omittedCount: number; truncated: boolean; diagnostics: unknown[] };
    expect(Buffer.byteLength(JSON.stringify(modelCollection.details), "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(modelCollection.details).toMatchObject({ operation: "inspect", kind: "collection", collection: "profiles", outcome: "success" });
    const expectedModelNames = modelProfiles.map((item) => item.name).sort();
    for (const [index, item] of (modelCollection.details.items as Array<Record<string, unknown>>).entries()) {
      expect(item.name).toBe(expectedModelNames[index]);
      expect((item.source as Record<string, unknown>).path).toBe(`/model/${Number(String(item.name).slice("model-".length))}`);
    }
    expect(Buffer.byteLength(contentText(modelCollection), "utf8")).toBeLessThanOrEqual(16_000);
    expect(modelContent.collection).toBe("profiles");
    expect(modelContent.truncated).toBe(true);
    expect(modelContent.items.length + modelContent.omittedCount).toBe(modelProfiles.length);
    for (const [index, item] of modelContent.items.entries()) {
      expect(item.name).toBe(expectedModelNames[index]);
      expect((item.source as Record<string, unknown>).path).toBe(`/model/${Number(String(item.name).slice("model-".length))}`);
    }
    expect(modelContent.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "OUTPUT_TRUNCATED" })]));
    const diagnosticOnlyDiagnostics = Array.from({ length: 20 }, (_, index) => ({ code: "DISCOVERY_ERROR" as const, name: `diagnostic-${index}`, message: `message-${index}`, path: `/diagnostic/${index}` }));
    const diagnosticOnlyTool = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => ({ effective: new Map([[worker.name, worker]]), candidates: [{ name: worker.name, profile: worker, source: worker.source }], diagnostics: diagnosticOnlyDiagnostics }) } });
    const diagnosticOnly = await diagnosticOnlyTool.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never);
    const diagnosticOnlyContent = JSON.parse(contentText(diagnosticOnly)) as { diagnosticOmittedCount: number; diagnostics: Array<Record<string, unknown>>; truncated: boolean };
    expect(diagnosticOnly.details).toMatchObject({ truncated: true, omittedCount: 0, diagnosticOmittedCount: 4 });
    expect((diagnosticOnly.details.diagnostics as Array<Record<string, unknown>>).find((item) => item.name === "diagnostic-15")).toMatchObject({ message: "message-15", path: "/diagnostic/15" });
    expect(diagnosticOnlyContent).toMatchObject({ truncated: true, diagnosticOmittedCount: 4 });
    expect(diagnosticOnlyContent.diagnostics.find((item) => item.name === "diagnostic-15")).toMatchObject({ message: "message-15", path: "/diagnostic/15" });
    const byteDiagnostics = Array.from({ length: 16 }, (_, index) => ({ code: "DISCOVERY_ERROR" as const, name: `diagnostic-${index}-${"n".repeat(120)}`, message: "m".repeat(512), path: `/diagnostic/${"p".repeat(512)}` }));
    const byteDiagnosticTool = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => ({ effective: new Map([[worker.name, worker]]), candidates: [{ name: worker.name, profile: worker, source: worker.source }], diagnostics: byteDiagnostics }) } });
    const byteDiagnosticResult = await byteDiagnosticTool.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never);
    const byteDiagnosticContent = JSON.parse(contentText(byteDiagnosticResult)) as { items: unknown[]; omittedCount: number; diagnosticOmittedCount: number; truncated: boolean; diagnostics: unknown[] };
    expect(Buffer.byteLength(JSON.stringify(byteDiagnosticResult.details), "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(Buffer.byteLength(contentText(byteDiagnosticResult), "utf8")).toBeLessThanOrEqual(16_000);
    expect(byteDiagnosticContent.truncated).toBe(true);
    expect(byteDiagnosticContent.items.length + byteDiagnosticContent.omittedCount).toBe(1);
    expect(byteDiagnosticContent.diagnosticOmittedCount).toBeGreaterThan(0);
    expect(byteDiagnosticContent.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "OUTPUT_TRUNCATED" })]));
    const blockedProfile = { ...worker, name: "blocked-low", source: profileSource("bundled", "/tmp/blocked-low.md", "/tmp") };
    const blockedCatalog = { ...catalog, effective: new Map([[blockedProfile.name, blockedProfile]]), candidates: [{ name: blockedProfile.name, profile: blockedProfile, source: blockedProfile.source }], unreadableScopes: ["project"] as const };
    const blockedTool = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => blockedCatalog } });
    const blockedCollection = await blockedTool.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never);
    expect(JSON.stringify(blockedCollection.details)).toContain("blocked by unreadable project profile scope");
    await expect(tool.execute("id", { mode: "collection", collection: "profiles", profile: "worker" } as never, new AbortController().signal, undefined, {} as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(tool.execute("id", { mode: "collection", collection: "profiles", target: "current" } as never, new AbortController().signal, undefined, {} as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(tool.execute("id", { mode: "profile", profile: "worker" } as never, new AbortController().signal, undefined, {} as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const unavailable = createInspectTool({ cli: noCli, context: {} });
    await expect(unavailable.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never)).rejects.toMatchObject({ code: "PROFILE_CATALOG_UNAVAILABLE" });
  });

  it("loads an empty bundled catalog and keeps the role-plugin skill pool on disk", async () => {
    const runtime = createRuntime({ exec: async () => { throw new Error("unused"); } }, { HERDR_ENV: "1" });
    const catalog = await runtime.profiles.load();
    // B10 deleted the 24 bundled profile files. Discovery still serves user
    // and project scopes, so the loader works but no bundled entries remain.
    expect(catalog.candidates.filter((candidate) => candidate.source.kind === "bundled")).toEqual([]);
    expect(catalog.diagnostics.filter((diagnostic) => diagnostic.source?.kind === "bundled")).toEqual([]);
    // The owner-approved role matrix lives on as the skill pool: each role
    // plugin keeps its manifest and its generated skill trees on disk.
    const rolePluginRoot = join(process.cwd(), "herdr-profiles", "role-plugins");
    const rolePluginSkills = {
      manager: ["manager", "harness-flow"],
      scout: ["scout"],
      planner: ["planner", "ponytail", "blueprint", "adr", "engineering-project-manager", "ticket-writer", "delivery-assurance", "humanizer"],
      worker: ["worker", "ponytail", "tdd", "git-flow", "adr", "typescript", "delivery-assurance"],
      reviewer: ["reviewer", "ponytail", "adr", "typescript", "delivery-assurance", "oracle", "pi-review-pr"],
      researcher: ["researcher", "humanizer"],
      promoter: ["promoter", "git-flow", "delivery-assurance", "courier-pr-gates", "dev-evidence-gate", "release-pr-validation", "shared-dev-deploy", "authenticated-staging-smoke", "services-ci-gates"]
    } as const;
    for (const role of ["manager", "scout", "planner", "worker", "reviewer", "researcher", "promoter"] as const) {
      await expect(access(join(rolePluginRoot, role, ".claude-plugin", "plugin.json"))).resolves.toBeUndefined();
      expect(JSON.parse(await readFile(join(rolePluginRoot, role, ".claude-plugin", "plugin.json"), "utf8"))).toMatchObject({ name: role === "manager" ? "herdr-tools" : `herdr-${role}-profile` });
      expect((await readdir(join(rolePluginRoot, role, "skills"))).sort()).toEqual([...rolePluginSkills[role]].sort());
      expect((await readFile(join(rolePluginRoot, role, "skills", role, "SKILL.md"), "utf8")).trim().length).toBeGreaterThan(0);
    }
  });
});
