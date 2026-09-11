import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AGY_MODES, attachmentCapability, buildClaudeArgv, buildPiArgv, buildProfileArgv, defaultPromptSourceStore, discoverProfiles, normalizeScopedResourcePath, parseProfile, profileCatalog, profileNameFromPath, profileSource, readProfileText, resolveProfile, validateProfileResourceSelection, ProfileParseError, ProfileResolutionError, MAX_PROFILE_BYTES, type DevinPermissionMode, type ProfileReadIo } from "../../src/profiles/index.js";
import { createInspectTool, fitInspectionValue } from "../../src/tools/inspect.js";
import { createLaunchTool as createLaunchToolImplementation, validateLaunchParams, LAUNCH_DIAGNOSTIC_MARKER, LAUNCH_RECOVERY_GUIDANCE, type LaunchDependencies } from "../../src/tools/launch.js";
import { createRuntime } from "../../index.js";
import type { HerdrCli } from "../../src/cli.js";
import { stubSupervision } from "./supervision-fixtures.js";

function launchDiagnostic(error: Error): Record<string, unknown> {
  const prefix = `\n${LAUNCH_DIAGNOSTIC_MARKER} `;
  const offset = error.message.indexOf(prefix);
  if (offset < 0) throw new Error(`missing ${LAUNCH_DIAGNOSTIC_MARKER}`);
  return JSON.parse(error.message.slice(offset + prefix.length)) as Record<string, unknown>;
}

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

const testPreflight = async () => undefined;
const createLaunchTool = (deps: Omit<LaunchDependencies, "preflight" | "supervision"> & Partial<Pick<LaunchDependencies, "preflight" | "supervision">>) => createLaunchToolImplementation({ ...deps, preflight: deps.preflight ?? testPreflight, supervision: deps.supervision ?? stubSupervision() });

const noCli = { runJson: async () => { throw new Error("CLI must not be called"); }, runText: async () => { throw new Error("CLI must not be called"); } } as unknown as HerdrCli;
/**
 * The Codex adapter (`pi-codex-conversion`) owned tool surface, in the adapter's
 * own `ALL_ADAPTER_TOOL_NAMES` order. Pi applies the `--tools` allowlist to
 * extension tools as well as built-ins, and the adapter deactivates itself when
 * any tool in its *current runtime plan* is missing from the resulting registry.
 * The plan is a mode- and config-dependent subset of these names, so all twelve
 * are allowlisted to keep every user-selectable adapter mode reachable rather
 * than because any single plan needs all of them. Availability is not
 * activation: the adapter activates only its planned subset and drops native
 * read/bash/edit/write while it runs.
 */
const CODEX_ADAPTER_PI_TOOLS = ["change_reasoning", "exec_command", "write_stdin", "apply_patch", "exec", "wait", "notebook", "view_image", "new_context", "get_context_remaining", "history", "notes"] as const;
/** Every launch carries the mandatory typed assignment. */
const ASSIGNMENT = { objective: "do the work", scope: "only this module", verification: "run the tests" };
/** The pre-prompt idle readiness baseline, then the advanced post-prompt sample. */
const lifecycle = (advanced: number): Record<string, unknown> => advanced === 0
  ? { agent_status: "idle", state_change_seq: 7, revision: 3, interactive_ready: true }
  : { agent_status: "working", state_change_seq: 8, revision: 4, interactive_ready: true };

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
    expect(resolveProfile("promoter-pi", catalog).profile.source.kind).toBe("bundled");
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
    expect(await profileCatalog({ bundledDir: join(root, "missing-bundled") })()).toMatchObject({ effective: expect.any(Map) });
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
    for (const unreadableScope of ["bundled", "user", "project"] as const) {
      expect(() => resolveProfile("missing", { effective: new Map(), candidates: [], diagnostics: [], unreadableScopes: [unreadableScope] })).toThrow(new RegExp(`${unreadableScope}.*unreadable`));
    }
    expect(() => resolveProfile("missing", { effective: new Map(), candidates: [], diagnostics: [], unreadableScopes: ["bundled", "user", "project"] })).toThrow(/project/);
    const bundledWorker = { ...make("worker", []), source: profileSource("bundled", "/bundled/worker.md", "/bundled") };
    const invalidProject = { name: "worker", source: profileSource("project", "/project/worker.md", "/project"), diagnostic: { code: "INVALID_PROFILE" as const, message: "project invalid" } };
    expect(() => resolveProfile("worker", { effective: new Map(), blocked: new Set(["worker"]), candidates: [{ name: "worker", profile: bundledWorker, source: bundledWorker.source }, { name: "worker", source: profileSource("user", "/user/worker.md", "/user"), diagnostic: { code: "INVALID_PROFILE" as const, message: "user invalid" } }, invalidProject], diagnostics: [{ code: "DISCOVERY_ERROR" as const, message: "user unreadable", source: profileSource("user", "/user", "/home") }], unreadableScopes: ["user"] })).toThrow(/invalid higher-precedence/);
    const invalidUser = { name: "worker", source: profileSource("user", "/user/worker.md", "/user"), diagnostic: { code: "INVALID_PROFILE" as const, message: "user invalid" } };
    expect(() => resolveProfile("worker", { effective: new Map([[bundledWorker.name, bundledWorker]]), candidates: [{ name: "worker", profile: bundledWorker, source: bundledWorker.source }, invalidUser], diagnostics: [{ code: "DISCOVERY_ERROR" as const, message: "project unreadable", source: profileSource("project", "/project", "/project") }], unreadableScopes: ["project"] })).toThrow(/unreadable project/);
    expect(() => resolveProfile("worker", { effective: new Map(), candidates: [invalidUser], diagnostics: [{ code: "DISCOVERY_ERROR" as const, message: "user unreadable", source: profileSource("user", "/user", "/home") }], unreadableScopes: ["user"] })).toThrow(/invalid higher-precedence/);
    const shared = new Map([make("root", ["next", "last"]), make("next", ["last"]), make("last", [])].map((item) => [item.name, item] as const));
    expect(resolveProfile("root", { effective: shared, candidates: [], diagnostics: [] }).reachableNames).toEqual(["root", "next", "last"]);
    const fanout = new Map([make("root", ["next", "last", "end", "extra"]), make("next", []), make("last", []), make("end", []), make("extra", [])].map((item) => [item.name, item] as const));
    expect(() => resolveProfile("root", { effective: fanout, candidates: [], diagnostics: [] })).toThrow(ProfileResolutionError);
    expect(() => resolveProfile("blocked", { effective, blocked: new Set(["blocked"]), candidates: [], diagnostics: [] })).toThrow(/blocked/);
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

    const exact = content(await tool.execute("id", { mode: "profile", profile: "researcher" } as never, new AbortController().signal, undefined, {} as never));
    expect(exact.profile).toMatchObject({ kind: "agy", mode: "plan", dangerouslySkipPermissions: true });
  });

  it("validates profile launch input before placement", () => {
    const invalid = [
      { name: "worker" }, { name: "worker", kind: "pi", profile: "worker" }, { name: "worker", profile: "" },
      { name: "worker", profile: "worker", argv: [] }, { name: "worker", profile: "worker", env: {} },
      { name: "worker", profile: "worker", overrides: null }, { name: "worker", profile: "worker", overrides: { unknown: "x" } },
      { name: "worker", profile: "worker", overrides: { model: "" } }, { name: "worker", profile: "worker", overrides: { tools: ["bad\nvalue"] } }, { name: "worker", kind: "pi", overrides: {} }
    ];
    for (const [index, value] of invalid.entries()) expect(() => validateLaunchParams({ ...(value as Record<string, unknown>), assignment: ASSIGNMENT } as never), `invalid case ${index}`).toThrow();
    // The typed assignment is itself required, so every case above is invalid without it too.
    for (const [index, value] of invalid.entries()) expect(() => validateLaunchParams(value as never), `promptless case ${index}`).toThrow();
    expect(() => validateLaunchParams({ name: "worker", profile: "worker", assignment: ASSIGNMENT, overrides: { thinking: "low", tools: ["read"], allowedTools: ["Read"], disallowedTools: ["Bash"], addDirs: ["."] } } as never)).not.toThrow();
    expect(() => validateLaunchParams({ name: "worker", profile: "worker" } as never)).toThrow(/assignment/);
    for (const key of ["extensions", "skills", "pluginDirs"]) expect(() => validateLaunchParams({ name: "worker", profile: "worker", assignment: ASSIGNMENT, overrides: { [key]: ["./selected"] } } as never)).toThrow(/Unknown profile override/);
  });

  it("launches a resolved profile through the existing placement path", async () => {
    const root = "/tmp/profile-scope";
    const worker = parseProfile(profileText("worker"), source(root, "worker"));
    const calls: string[][] = [];
    const snapshot = { type: "session_snapshot", snapshot: { version: "0.8", protocol: 1, workspaces: [{ workspace_id: "w", label: "workspace" }], tabs: [{ tab_id: "w:t", workspace_id: "w", label: "main" }], panes: [{ pane_id: "w:p", tab_id: "w:t", workspace_id: "w", label: "caller", agent_status: "idle" }], agents: [] } };
    const promptSources = { create: vi.fn(async (body: string) => ({ path: `/tmp/profile-${Buffer.byteLength(body, "utf8")}.md` })) };
    let started = false;
    let lastName = "worker";
    let prompted = false;
    const identity = { terminal_id: "terminal-a", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-a" } };
    const cli = { runJson: async (argv: string[]) => {
      calls.push(argv);
      if (argv[0] === "pane" && argv[1] === "current") return { id: "current", result: { type: "pane_current", pane: snapshot.snapshot.panes[0] } };
      if (argv[0] === "api") return { id: "snapshot", result: started ? { ...snapshot, snapshot: { ...snapshot.snapshot, panes: [...snapshot.snapshot.panes, { pane_id: "w:p2", tab_id: "w:t", workspace_id: "w", agent_name: lastName, agent: "pi", ...identity }], agents: [{ pane_id: "w:p2", name: lastName, agent: "pi", ...identity }] } } : snapshot };
      if (argv[0] === "pane" && argv[1] === "split") return { id: "split", result: { pane: { pane_id: "w:p2", tab_id: "w:t" } } };
      if (argv[0] === "pane" && argv[1] === "rename") return { id: "rename", result: {} };
      if (argv[0] === "agent" && argv[1] === "start") { started = true; prompted = false; lastName = argv[2]!; return { id: "start", result: { agent: { name: argv[2], pane_id: "w:p2", agent: "pi", ...identity } } }; }
      if (argv[0] === "agent" && argv[1] === "get") return { id: "agent-get", result: { agent: { name: lastName, pane_id: "w:p2", agent: "pi", ...identity, ...lifecycle(prompted ? 1 : 0) } } };
      if (argv[0] === "pane" && argv[1] === "get") return { id: "get", result: { pane: { pane_id: "w:p2", tab_id: "w:t", workspace_id: "w", agent_name: lastName, agent: "pi", ...identity, ...lifecycle(prompted ? 1 : 0) } } };
      throw new Error(`unexpected ${argv.join(" ")}`);
    }, prompt: async () => {
      calls.push(["agent", "prompt", "w:p2"]);
      // The acknowledgement reports the pre-advance baseline; only the reads
      // after it advance, which is what the confirmation loop looks for.
      const acknowledgement = { id: "cli:agent:prompt", result: { type: "agent_prompted", agent: { name: lastName, pane_id: "w:p2", agent: "pi", ...identity, ...lifecycle(0), screen_detection_skipped: true } } };
      prompted = true;
      return acknowledgement;
    } } as unknown as HerdrCli;
    const result = await createLaunchTool({ cli, context: { workspaceId: "w", tabId: "w:t", paneId: "w:p" }, cwd: "/repo", promptSources, profiles: { load: async () => ({ effective: new Map([[worker.name, worker]]), candidates: [], diagnostics: [] }) } }).execute("id", { name: "worker", profile: "worker", assignment: ASSIGNMENT } as never, new AbortController().signal, undefined, { cwd: "/repo" } as never);
    expect(promptSources.create).toHaveBeenCalledWith("\nBody for worker.\n");
    expect(calls).toContainEqual(["agent", "start", "worker", "--kind", "pi", "--pane", "w:p2", "--timeout", "120000", "--", "--model", "test/model", "--thinking", "low", "--no-skills", "--no-session", "--append-system-prompt", "/tmp/profile-18.md"]);
    expect(result.details).toMatchObject({ profile: { name: "worker", fallbackProfiles: [], timeoutMinutes: 30 }, kind: "pi" });
    const defaultCreate = vi.spyOn(defaultPromptSourceStore, "create").mockResolvedValue({ path: "/tmp/default-profile.md" });
    try {
      await createLaunchTool({ cli, context: { workspaceId: "w", tabId: "w:t", paneId: "w:p" }, cwd: "/repo", profiles: { load: async () => ({ effective: new Map([[worker.name, worker]]), candidates: [], diagnostics: [] }) } }).execute("id", { name: "worker-default", profile: "worker", assignment: ASSIGNMENT } as never, new AbortController().signal, undefined, { cwd: "/repo" } as never);
      expect(defaultCreate).toHaveBeenCalledWith("\nBody for worker.\n");
    } finally {
      defaultCreate.mockRestore();
    }

    const storeFailure = new Error("prompt cache unavailable");
    const callsBeforeFailure = calls.length;
    // The store failure is a foreign error, so the launch boundary rethrows a
    // typed LaunchError instead of the original: the model contract is the code,
    // the failed phase, and the no-effect diagnostic, never the store's own text.
    const storeRejection = await createLaunchTool({ cli, context: { workspaceId: "w", tabId: "w:t", paneId: "w:p" }, cwd: "/repo", promptSources: { create: async () => { throw storeFailure; } }, profiles: { load: async () => ({ effective: new Map([[worker.name, worker]]), candidates: [], diagnostics: [] }) } }).execute("id", { name: "worker-2", profile: "worker", assignment: ASSIGNMENT } as never, new AbortController().signal, undefined, { cwd: "/repo" } as never).then(() => undefined, (error: unknown) => error as Error & { code: string; details: Record<string, unknown> });
    expect(storeRejection).toMatchObject({ code: "CLI_PROTOCOL_ERROR", details: { phase: "resolve_profile", causeCode: "CLI_PROTOCOL_ERROR", effectCertainty: "absent", agentStarted: false, promptSubmitted: false, recipientRegistered: false } });
    expect(launchDiagnostic(storeRejection!)).toEqual({ code: "CLI_PROTOCOL_ERROR", phase: "resolve_profile", created: {}, agentStarted: false, promptSubmitted: false, recipientRegistered: false, effectCertainty: "absent", recoveryGuidance: LAUNCH_RECOVERY_GUIDANCE.noEffect });
    expect(storeRejection!.message).not.toContain(storeFailure.message);
    expect(calls).toHaveLength(callsBeforeFailure);
    const invalidPathCalls = calls.length;
    await expect(createLaunchTool({ cli, context: { workspaceId: "w", tabId: "w:t", paneId: "w:p" }, cwd: "/repo", promptSources: { create: async () => ({ path: "/tmp/invalid\nprofile.md" }) }, profiles: { load: async () => ({ effective: new Map([[worker.name, worker]]), candidates: [], diagnostics: [] }) } }).execute("id", { name: "worker-3", profile: "worker", assignment: ASSIGNMENT } as never, new AbortController().signal, undefined, { cwd: "/repo" } as never)).rejects.toMatchObject({ code: "INVALID_PROFILE_OVERRIDE", details: { causeCode: "INVALID_PROFILE_OVERRIDE" } });
    expect(calls).toHaveLength(invalidPathCalls);
  });

  it("inspects bounded profile collections and exact profiles without Herdr reads", async () => {
    const root = "/tmp/profile-scope";
    const worker = parseProfile(profileText("worker"), source(root, "worker"));
    const claudeBase = parseProfile(profileText("claude", "claude"), source(root, "claude"));
    const claude = { ...claudeBase, runtime: { ...claudeBase.runtime, allowedTools: ["Read"], disallowedTools: ["Bash"], addDirs: ["/docs"], pluginDirs: ["/plugin"] } };
    const longBody = { ...worker, name: "long", source: source(root, "long"), body: "x".repeat(9_000) };
    const hugeMetadata = { ...worker, name: "huge", source: source(root, "huge"), description: "d".repeat(100_000) };
    const fallbackRoot = { ...worker, name: "fallback-root", source: source(root, "fallback-root"), fallbackProfiles: [worker.name] };
    const catalog = { effective: new Map([[worker.name, worker], [longBody.name, longBody], [hugeMetadata.name, hugeMetadata], [fallbackRoot.name, fallbackRoot], [claude.name, claude]]), blocked: new Set(["blocked-no-diagnostic"]), candidates: [{ name: worker.name, profile: worker, source: worker.source }, { name: hugeMetadata.name, profile: hugeMetadata, source: hugeMetadata.source }, { name: fallbackRoot.name, profile: fallbackRoot, source: fallbackRoot.source }, { name: claude.name, profile: claude, source: claude.source }, { name: "invalid", source: source(root, "invalid"), diagnostic: { code: "INVALID_PROFILE" as const, message: "bad" } }, { name: "invalid", source: source(root, "invalid-2"), diagnostic: { code: "INVALID_PROFILE" as const, message: "bad again" } }, { name: "invalid-no-message", source: source(root, "invalid-no-message"), diagnostic: { code: "INVALID_PROFILE" as const } as never }, { name: "blocked-no-diagnostic", source: source(root, "blocked-no-diagnostic") }, { name: "no-diagnostic", source: source(root, "no-diagnostic") }], diagnostics: [{ code: "SHADOWED_PROFILE" as const, message: "test", name: "worker", path: "/tmp/shadowed" }, { code: "DISCOVERY_ERROR" as const, message: "scope read failed", path: "/tmp/unreadable" }] };
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
    const promoter = { ...blockedWorker, name: "promoter-pi", source: profileSource("bundled", "/bundled/promoter-pi.md", "/bundled") };
    const reservedInspection = createInspectTool({ cli: noCli, context: {}, profiles: { load: async () => ({
      effective: new Map([[promoter.name, promoter]]),
      candidates: [
        { name: promoter.name, profile: promoter, source: promoter.source },
        { name: promoter.name, source: profileSource("project", "/project/promoter-pi.md", "/project"), diagnostic: { code: "INVALID_PROFILE" as const, message: "project invalid" } }
      ],
      diagnostics: [{ code: "DISCOVERY_ERROR" as const, message: "project scope unreadable", source: profileSource("project", "/project", "/project") }],
      unreadableScopes: ["project"] as const
    }) } });
    const reservedResult = await reservedInspection.execute("id", { mode: "collection", collection: "profiles" } as never, new AbortController().signal, undefined, {} as never);
    expect(reservedResult.details).toMatchObject({ items: [expect.objectContaining({ name: "promoter-pi", source: expect.objectContaining({ kind: "bundled" }) })] });
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
    expect(Buffer.byteLength(contentText(huge), "utf8")).toBeLessThanOrEqual(16_000);
    expect(() => JSON.parse(contentText(huge))).not.toThrow();
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
    await expect(tool.execute("id", { mode: "profile", profile: "worker", target: "current" } as never, new AbortController().signal, undefined, {} as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(tool.execute("id", { mode: "profile", profile: "missing" } as never, new AbortController().signal, undefined, {} as never)).rejects.toMatchObject({ code: "PROFILE_RESOLUTION_INVALID" });
    const unavailable = createInspectTool({ cli: noCli, context: {} });
    await expect(unavailable.execute("id", { mode: "profile", profile: "worker" } as never, new AbortController().signal, undefined, {} as never)).rejects.toMatchObject({ code: "PROFILE_CATALOG_UNAVAILABLE" });
  });

  it("enforces the bundled capability matrix and shared role resources", async () => {
    const runtime = createRuntime({ exec: async () => { throw new Error("unused"); } }, { HERDR_ENV: "1" });
    const catalog = await runtime.profiles.load();
    expect(catalog.effective.size).toBe(24);
    expect(catalog.diagnostics).toEqual([]);
    const bundledRoot = catalog.effective.get("manager-pi")!.source.scopeRoot;
    const rolePluginRoot = join(bundledRoot, "herdr-profiles", "role-plugins");
    const managerProfilePlugin = join(bundledRoot, "herdr-profiles", "profile-plugins", "manager");
    const executorProfilePlugin = join(bundledRoot, "herdr-profiles", "profile-plugins", "executor");
    const executorRoles = new Set(["manager", "planner", "researcher", "promoter"]);
    const executorPiTools = ["mcp", "executor_execute", "executor_skills", "executor_resume"];
    const executorClaudeTool = "mcp__plugin_herdr-executor_executor";
    const ponytailRoles = new Set(["planner", "worker", "reviewer"]);
    const roleNames = ["manager", "scout", "planner", "worker", "reviewer", "researcher", "promoter"];
    for (const role of roleNames) {
      const manifestPath = join(rolePluginRoot, role, ".claude-plugin", "plugin.json");
      const skillPath = join(rolePluginRoot, role, "skills", role, "SKILL.md");
      await expect(access(manifestPath)).resolves.toBeUndefined();
      await expect(access(skillPath)).resolves.toBeUndefined();
      expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({ name: role === "manager" ? "herdr-tools" : `herdr-${role}-profile` });
      expect((await readFile(skillPath, "utf8")).trim().length).toBeGreaterThan(0);
    }

    const piTools = {
      manager: ["read", "grep", "find", "ls", "edit", "write", "ask_user_question", ...executorPiTools, "herdr_inspect", "herdr_launch", "herdr_communicate", "herdr_wait", "herdr_jobs", "herdr_pane", "herdr_tab", ...CODEX_ADAPTER_PI_TOOLS],
      scout: ["read", "bash", "grep", "find", "ls", "ffgrep", "fffind", "ctx_execute", "ctx_execute_file", "ctx_search", "edit", "write", ...CODEX_ADAPTER_PI_TOOLS],
      planner: ["read", "bash", "grep", "find", "ls", "ffgrep", "fffind", "ctx_execute", "ctx_execute_file", "ctx_search", "web_search", "source_check", "fetch_content", "get_search_content", ...executorPiTools, "edit", "write", ...CODEX_ADAPTER_PI_TOOLS],
      worker: ["read", "bash", "grep", "find", "ls", "ffgrep", "fffind", "ctx_execute", "ctx_execute_file", "ctx_search", "web_search", "source_check", "fetch_content", "get_search_content", "edit", "write", "bash_bg", "jobs", "job_decide", "monitor", ...CODEX_ADAPTER_PI_TOOLS],
      reviewer: ["read", "bash", "grep", "find", "ls", "ffgrep", "fffind", "ctx_execute", "ctx_execute_file", "ctx_search", "web_search", "source_check", "fetch_content", "get_search_content", "edit", "write", ...CODEX_ADAPTER_PI_TOOLS],
      researcher: ["read", "bash", "grep", "find", "ls", "ffgrep", "fffind", "ctx_execute", "ctx_execute_file", "ctx_search", "web_search", "source_check", "fetch_content", "get_search_content", ...executorPiTools, "edit", "write", ...CODEX_ADAPTER_PI_TOOLS],
      promoter: ["read", "bash", "grep", "find", "ls", "ctx_execute", "ctx_execute_file", "ctx_search", ...executorPiTools, "edit", "write", ...CODEX_ADAPTER_PI_TOOLS]
    } as const;
    // Every bundled Pi profile allowlists the whole owned Codex adapter surface,
    // in the adapter's own order. Any plan tool Pi filters out of the registry
    // deactivates the adapter, so allowlisting the full surface keeps every
    // selectable mode's plan satisfiable.
    for (const role of roleNames) {
      expect(piTools[role as keyof typeof piTools].slice(-CODEX_ADAPTER_PI_TOOLS.length), `${role} adapter tools`).toEqual([...CODEX_ADAPTER_PI_TOOLS]);
    }
    // The owner-approved role matrix. Every entry beyond the embedded role skill
    // is a generated bundle pinned in `herdr-skill-bundles.json`; the two Pi-only
    // globals live outside every plugin directory so no Claude role receives them.
    // The manager role plugin is the globally installed `herdr-tools` package, so
    // it keeps only its own two skills and the manager extras are generated into
    // the separate session-only manager profile plugin.
    const managerProfileSkills = ["herdr-manager", "engineering-project-manager", "oracle", "pi-review-pr", "decision-batch", "delivery-assurance"];
    const rolePluginSkills = {
      manager: ["manager", "harness-flow"],
      scout: ["scout"],
      planner: ["planner", "ponytail", "blueprint", "adr", "engineering-project-manager", "ticket-writer", "delivery-assurance", "humanizer"],
      worker: ["worker", "ponytail", "tdd", "git-flow", "adr", "typescript", "delivery-assurance"],
      reviewer: ["reviewer", "ponytail", "adr", "typescript", "delivery-assurance", "oracle", "pi-review-pr"],
      researcher: ["researcher", "humanizer"],
      promoter: ["promoter", "git-flow", "delivery-assurance", "courier-pr-gates", "dev-evidence-gate", "release-pr-validation", "shared-dev-deploy", "authenticated-staging-smoke", "services-ci-gates"]
    } as const;
    // `manager-pi` orchestrates without bash or ctx tools, so it takes neither
    // global: a skill whose tools the profile withholds is dead weight in the
    // allowlist, and widening the manager's tools to fix that is not allowed.
    const piGlobalSkills = (role: string) => (role === "manager" ? [] : ["context-mode", "tmux-background-tasks"].map((skill) => join(bundledRoot, "herdr-profiles", "pi-skills", skill)));
    const piSkills = (role: string) => [
      ...rolePluginSkills[role as keyof typeof rolePluginSkills].map((skill) => join(rolePluginRoot, role, "skills", skill)),
      // `manager-pi` reads the manager extras from the same generated profile
      // plugin `manager-claude` loads, but keeps its own two canonical skills.
      ...(role === "manager" ? managerProfileSkills.map((skill) => join(managerProfilePlugin, "skills", skill)) : []),
      ...(executorRoles.has(role) ? [join(executorProfilePlugin, "skills", "executor")] : []),
      ...piGlobalSkills(role)
    ];
    for (const role of roleNames) {
      const profile = catalog.effective.get(`${role}-pi`)!;
      expect(profile.runtime).toEqual({ kind: "pi", model: expect.any(String), thinking: expect.any(String), tools: [...piTools[role as keyof typeof piTools]], extensions: [], skills: piSkills(role) });
      expect(profile.runtime.kind === "pi" && profile.runtime.tools.includes("Agent")).toBe(false);
      // A Claude role sees exactly the plugin's own skill trees, so the matrix is
      // asserted on disk as well as in the Pi allowlist.
      expect((await readdir(join(rolePluginRoot, role, "skills"))).sort()).toEqual([...rolePluginSkills[role as keyof typeof rolePluginSkills]].sort());
      await expect(validateProfileResourceSelection(profile, profile.runtime)).resolves.toBeUndefined();
      await expect(validateProfileResourceSelection(catalog.effective.get(`${role}-claude`)!, catalog.effective.get(`${role}-claude`)!.runtime)).resolves.toBeUndefined();
    }
    const reviewerRole = await readFile(join(rolePluginRoot, "reviewer", "skills", "reviewer", "SKILL.md"), "utf8");
    expect(reviewerRole).toContain("not a verdict to repeat");
    expect(reviewerRole).toContain("`must-fix`, `follow-up`, `nit`, `defense-in-depth`, or `not-a-finding`");
    const piReviewSkill = await readFile(join(rolePluginRoot, "reviewer", "skills", "pi-review-pr", "SKILL.md"), "utf8");
    expect(piReviewSkill).toContain("It is not an automatic must-fix list");
    expect(piReviewSkill).toContain("Reported severity is evidence, not the final classification");

    const executorManifest = JSON.parse(await readFile(join(executorProfilePlugin, ".claude-plugin", "plugin.json"), "utf8"));
    expect(executorManifest).toMatchObject({ name: "herdr-executor", mcpServers: "./mcp-servers.json" });
    const executorServers = JSON.parse(await readFile(join(executorProfilePlugin, "mcp-servers.json"), "utf8"));
    expect(executorServers).toMatchObject({ executor: { type: "http", url: "https://dev-server.piranha-palermo.ts.net/mcp", headersHelper: "${CLAUDE_PLUGIN_ROOT}/scripts/headers-helper.sh" } });
    const executorHeadersHelperPath = join(executorProfilePlugin, "scripts", "headers-helper.sh");
    const executorHeadersHelper = await readFile(executorHeadersHelperPath, "utf8");
    expect(executorHeadersHelper).toContain("MCP_EXECUTOR_API_KEY");
    const helperResult = spawnSync(executorHeadersHelperPath, { encoding: "utf8" });
    const helperHeaders = JSON.parse(helperResult.stdout) as Record<string, unknown>;
    expect({
      status: helperResult.status,
      executable: Boolean((await stat(executorHeadersHelperPath)).mode & 0o111),
      keys: Object.keys(helperHeaders),
      bearer: typeof helperHeaders.Authorization === "string" && /^Bearer \S+$/.test(helperHeaders.Authorization)
    }).toEqual({ status: 0, executable: true, keys: ["Authorization"], bearer: true });
    await expect(access(join(executorProfilePlugin, "pi.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(join(executorProfilePlugin, "skills"))).sort()).toEqual(["executor"]);
    const executorSkill = await readFile(join(executorProfilePlugin, "skills", "executor", "SKILL.md"), "utf8");
    expect(executorSkill).toContain("`executor_execute`, `executor_skills`, and `executor_resume`");
    expect(executorSkill).toContain("`mcp__plugin_herdr-executor_executor__execute`");

    // The manager skill plugin holds the whole manager matrix. Executor stays
    // separate so only the four selected roles load its MCP server.
    expect((await readdir(join(managerProfilePlugin, "skills"))).sort()).toEqual([...rolePluginSkills.manager, ...managerProfileSkills].sort());
    const managerRole = await readFile(join(rolePluginRoot, "manager", "skills", "manager", "SKILL.md"), "utf8");
    expect(managerRole).toContain("Both managers receive Edit and Write only for an exact assignment-supplied handoff or coordination path");
    expect(catalog.effective.get("manager-pi")?.runtime).toEqual({ kind: "pi", model: "openai-codex/gpt-6-astra", thinking: "xhigh", tools: [...piTools.manager], extensions: [], skills: piSkills("manager") });
    expect(catalog.effective.get("manager-pi")?.fallbackProfiles).toEqual(["manager-devin"]);
    const managerClaude = catalog.effective.get("manager-claude")!;
    const managerClaudeTools = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "AskUserQuestion", "Skill", "ToolSearch", "Edit", "Write", "mcp__plugin_herdr-tools_herdr", executorClaudeTool];
    expect(managerClaude.runtime).toEqual({ kind: "claude", model: "fable", effort: "high", permissionMode: "default", allowedTools: managerClaudeTools, disallowedTools: ["Task"], addDirs: [], pluginDirs: [managerProfilePlugin, executorProfilePlugin], developmentChannels: [] });
    // The rolling alias tracks the latest supported Fable model, and the profile
    // opts into no development channel, so no inbound-channel flag is emitted.
    expect(managerClaude.runtime.kind === "claude" && managerClaude.runtime.developmentChannels).toEqual([]);
    expect(buildProfileArgv(managerClaude)).not.toEqual(expect.arrayContaining(["--dangerously-load-development-channels"]));
    expect(buildProfileArgv(managerClaude)).not.toEqual(expect.arrayContaining(["server:herdr"]));
    expect(managerClaude.sessionPersistence).toBe(true);
    expect(managerClaude.timeoutMinutes).toBe(30);
    expect(managerClaude.fallbackProfiles).toEqual(["manager-pi"]);
    expect(managerClaude.runtime.kind === "claude" && managerClaude.runtime.allowedTools).toEqual(expect.arrayContaining(["Edit", "Write"]));
    expect(managerClaude.runtime.kind === "claude" && managerClaude.runtime.allowedTools).not.toEqual(expect.arrayContaining(["Bash", "NotebookEdit"]));
    expect(managerClaude.runtime.kind === "claude" && managerClaude.runtime.disallowedTools).toEqual(["Task"]);
    expect(buildProfileArgv(managerClaude)).toEqual(["--model", "fable", "--effort", "high", "--permission-mode", "default", ...managerClaudeTools.flatMap((tool) => ["--allowed-tools", tool]), "--disallowed-tools", "Task", "--plugin-dir", managerProfilePlugin, "--plugin-dir", executorProfilePlugin]);
    expect(catalog.effective.get("worker-pi")?.runtime).toMatchObject({ model: "openai-codex/gpt-5.6-luna", thinking: "max" });
    expect(catalog.effective.get("worker-pi")?.fallbackProfiles).toEqual(["worker-claude"]);
    const workerAgy = catalog.effective.get("worker-agy")!;
    expect(workerAgy.runtime).toEqual({ kind: "agy", model: "gemini-3.8-flash-high", mode: "accept-edits", addDirs: [] });
    expect(workerAgy.fallbackProfiles).toEqual(["worker-claude"]);
    expect(resolveProfile("worker-pi", catalog).reachableNames).toEqual(["worker-pi", "worker-claude"]);
    const workerDevin = catalog.effective.get("worker-devin")!;
    expect(workerDevin.runtime).toEqual({ kind: "devin", model: "swe-2-max", permissionMode: "dangerous" });
    expect(workerDevin.sessionPersistence).toBe(true);
    expect(workerDevin.timeoutMinutes).toBe(30);
    expect(workerDevin.fallbackProfiles).toEqual(["worker-pi"]);
    expect(workerDevin.source.kind).toBe("bundled");
    expect(resolveProfile("worker-devin", catalog).reachableNames).toEqual(["worker-devin", "worker-pi", "worker-claude"]);
    expect(buildProfileArgv(workerDevin)).toEqual(["--model", "swe-2-max", "--permission-mode", "dangerous"]);
    const reviewerDevin = catalog.effective.get("reviewer-devin")!;
    expect(reviewerDevin.runtime).toEqual({ kind: "devin", model: "swe-2-max", permissionMode: "dangerous" });
    expect(reviewerDevin.sessionPersistence).toBe(true);
    expect(reviewerDevin.timeoutMinutes).toBe(30);
    expect(reviewerDevin.fallbackProfiles).toEqual(["reviewer-pi"]);
    expect(reviewerDevin.source.kind).toBe("bundled");
    expect(resolveProfile("reviewer-devin", catalog).reachableNames).toEqual(["reviewer-devin", "reviewer-pi", "reviewer-claude"]);
    expect(buildProfileArgv(reviewerDevin)).toEqual(["--model", "swe-2-max", "--permission-mode", "dangerous"]);
    expect(reviewerDevin.body).toContain("read-only");
    const scoutAgy = catalog.effective.get("scout-agy")!;
    expect(scoutAgy.runtime).toEqual({ kind: "agy", model: "gemini-3.8-flash-low", mode: "plan", addDirs: [] });
    expect(scoutAgy.fallbackProfiles).toEqual(["scout-claude"]);
    expect(catalog.effective.get("scout-claude")?.fallbackProfiles).toEqual(["scout-devin"]);
    expect(resolveProfile("scout-agy", catalog).reachableNames).toEqual(["scout-agy", "scout-claude", "scout-devin", "scout-pi"]);
    const researcherAgy = catalog.effective.get("researcher-agy")!;
    expect(researcherAgy.runtime).toEqual({ kind: "agy", model: "gemini-3.8-flash-low", mode: "plan", addDirs: [] });
    expect(researcherAgy.sessionPersistence).toBe(true);
    expect(researcherAgy.timeoutMinutes).toBe(30);
    expect(researcherAgy.fallbackProfiles).toEqual(["researcher-claude"]);
    expect(researcherAgy.body).toBe("\nCatalog metadata only. Herdr does not deliver this profile body to AGY. Every AGY task must be self-contained and sent through Herdr's visible v1 provenance-wrapped assignment.\n");
    expect(buildProfileArgv(researcherAgy)).toEqual(["--model", "gemini-3.8-flash-low", "--mode", "plan", "--dangerously-skip-permissions", "--prompt-interactive", "Initialize this interactive session and reply with exactly AGY_READY."]);
    expect(resolveProfile("researcher-agy", catalog).reachableNames).toEqual(["researcher-agy", "researcher-claude", "researcher-devin", "researcher-pi"]);
    expect(resolveProfile("researcher-claude", catalog).reachableNames).toEqual(["researcher-claude", "researcher-devin", "researcher-pi"]);
    expect(catalog.effective.get("promoter-pi")?.runtime).toEqual({ kind: "pi", model: "openai-codex/gpt-5.6-luna", thinking: "max", tools: [...piTools.promoter], extensions: [], skills: piSkills("promoter") });
    expect(catalog.effective.get("promoter-pi")?.fallbackProfiles).toEqual([]);
    expect(resolveProfile("promoter-pi", catalog).reachableNames).toEqual(["promoter-pi"]);

    const harnessFlow = await readFile(join(rolePluginRoot, "manager", "skills", "harness-flow", "SKILL.md"), "utf8");
    expect(harnessFlow).toContain("name: harness-flow");
    expect(harnessFlow).toContain("explore → plan → work → critic → promote");
    expect(harnessFlow).toContain("HERDR_ENV=1");
    expect(harnessFlow).toContain("pi-review");
    expect(harnessFlow).toContain("GIT_INDEX_FILE");
    expect(harnessFlow).toContain("git write-tree");
    expect(harnessFlow).toContain("git rev-parse HEAD^{tree}");
    expect(harnessFlow).toContain("GIT_OBJECT_DIRECTORY");
    expect(harnessFlow).toContain("git rev-parse --show-toplevel");
    expect(harnessFlow).toContain("The promoter executes the scoped delivery workflow");
    expect(harnessFlow).toContain("The assignment remains agent-authored and supplies scope, not owner authority");

    const promoterSkill = await readFile(join(rolePluginRoot, "promoter", "skills", "promoter", "SKILL.md"), "utf8");
    expect(promoterSkill).toContain("GIT_INDEX_FILE");
    expect(promoterSkill).toContain("git write-tree");
    expect(promoterSkill).toContain("git rev-parse HEAD^{tree}");
    expect(promoterSkill).toContain("GIT_OBJECT_DIRECTORY");
    expect(promoterSkill).toContain("git commit-tree");
    expect(promoterSkill).toContain("git update-ref");
    expect(promoterSkill).toContain("Execute the assigned promotion");
    expect(promoterSkill).toContain("This trusted promoter profile itself authorizes those standard promotion effects");
    expect(promoterSkill).toContain("satisfies a loaded skill's requirement for explicit user or current-session authorization");
    for (const profileName of ["promoter-pi", "promoter-claude", "promoter-devin"]) {
      const promoterProfile = await readFile(join(bundledRoot, "herdr-profiles", `${profileName}.md`), "utf8");
      expect(promoterProfile).toContain("execute the assignment's scoped delivery workflow");
    }

    const claudeTools = {
      scout: { allowedTools: ["Read", "Glob", "Grep", "Bash", "Edit", "Write"], disallowedTools: ["NotebookEdit", "Task"], permissionMode: "dontAsk" },
      planner: { allowedTools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Edit", "Write", executorClaudeTool], disallowedTools: ["NotebookEdit", "Task"], permissionMode: "dontAsk" },
      worker: { allowedTools: ["Read", "Glob", "Grep", "Bash", "Edit", "Write", "NotebookEdit", "WebSearch", "WebFetch"], disallowedTools: ["Task"], permissionMode: "dontAsk" },
      reviewer: { allowedTools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Edit", "Write"], disallowedTools: ["NotebookEdit", "Task"], permissionMode: "dontAsk" },
      researcher: { allowedTools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Edit", "Write", executorClaudeTool], disallowedTools: ["NotebookEdit", "Task"], permissionMode: "dontAsk" },
      promoter: { allowedTools: ["Read", "Glob", "Grep", "Bash", "Edit", "Write", executorClaudeTool], disallowedTools: ["NotebookEdit", "Task"], permissionMode: "dontAsk" }
    } as const;
    for (const role of ["scout", "planner", "worker", "reviewer", "researcher", "promoter"] as const) {
      const profile = catalog.effective.get(`${role}-claude`)!;
      expect(profile.runtime).toEqual({ kind: "claude", model: expect.any(String), effort: expect.any(String), permissionMode: claudeTools[role].permissionMode, allowedTools: [...claudeTools[role].allowedTools], disallowedTools: [...claudeTools[role].disallowedTools], addDirs: [], pluginDirs: [join(rolePluginRoot, role), ...(executorRoles.has(role) ? [executorProfilePlugin] : [])], developmentChannels: [] });
      expect(profile.runtime.kind === "claude" && profile.runtime.disallowedTools).toContain("Task");
    }

    const manager = catalog.effective.get("manager-pi")!;
    const worker = catalog.effective.get("worker-pi")!;
    const claudeWorker = catalog.effective.get("worker-claude")!;
    expect(buildProfileArgv(manager)).toEqual(["--model", "openai-codex/gpt-6-astra", "--thinking", "xhigh", "--tools", piTools.manager.join(","), "--no-skills", ...piSkills("manager").flatMap((skill) => ["--skill", skill])]);
    expect(buildProfileArgv(worker)).toEqual(["--model", "openai-codex/gpt-5.6-luna", "--thinking", "max", "--tools", piTools.worker.join(","), "--no-skills", ...piSkills("worker").flatMap((skill) => ["--skill", skill])]);
    for (const profileName of ["worker-pi", "worker-claude"]) {
      const workerProfile = await readFile(join(bundledRoot, "herdr-profiles", `${profileName}.md`), "utf8");
      expect(workerProfile).toContain("For a `harness-flow` DAG node, leave the reviewed deliverable changes uncommitted for the promoter.");
    }

    expect(buildProfileArgv(claudeWorker)).toEqual(["--model", "claude-opus-5", "--effort", "high", "--permission-mode", "dontAsk", ...claudeTools.worker.allowedTools.flatMap((tool) => ["--allowed-tools", tool]), "--disallowed-tools", "Task", "--plugin-dir", join(rolePluginRoot, "worker")]);

    for (const role of ponytailRoles) {
      for (const runtime of ["pi", "claude"] as const) {
        expect(catalog.effective.get(`${role}-${runtime}`)?.body).toContain("Ponytail full mode is mandatory");
      }
    }
  });

  it("keeps every bundled Pi profile free of dead skill and thinking combinations", async () => {
    const runtime = createRuntime({ exec: async () => { throw new Error("unused"); } }, { HERDR_ENV: "1" });
    const catalog = await runtime.profiles.load();
    // A selected skill whose tools the profile withholds can never run, so the
    // matrix is invalid in both directions: drop the skill or grant the tools.
    const skillTools: Record<string, string[]> = { "context-mode": ["ctx_execute", "ctx_execute_file", "ctx_search"], "tmux-background-tasks": ["bash"] };
    // Scout and researcher intentionally trade some depth for faster focused discovery.
    const modelThinking: Record<string, string> = { "openai-codex/gpt-5.6-luna": "max", "openai-codex/gpt-5.6-sol": "medium" };
    const roleThinking: Record<string, string> = { "manager-pi": "xhigh", "scout-pi": "high", "researcher-pi": "high", "planner-pi": "xhigh" };
    const piProfiles = [...catalog.effective.values()].filter((profile) => profile.runtime.kind === "pi");
    expect(piProfiles.length).toBe(7);
    for (const profile of piProfiles) {
      expect(profile.sessionPersistence).toBe(true);
      const runtimeProfile = profile.runtime as Extract<typeof profile.runtime, { kind: "pi" }>;
      expect({ name: profile.name, thinking: runtimeProfile.thinking }).toEqual({ name: profile.name, thinking: roleThinking[profile.name] ?? modelThinking[runtimeProfile.model] ?? runtimeProfile.thinking });
      for (const [skill, required] of Object.entries(skillTools)) {
        if (!runtimeProfile.skills.some((path) => basename(path) === skill)) continue;
        expect({ name: profile.name, missing: required.filter((tool) => !runtimeProfile.tools.includes(tool)) }).toEqual({ name: profile.name, missing: [] });
      }
    }
  });

  it("keeps profile launch and renderer failures explicit", async () => {
    const launchTool = createLaunchToolImplementation({
      cli: { ...noCli, prompt: async () => { throw new Error("prompt must not be called"); } } as never,
      context: {},
      profiles: undefined,
      preflight: testPreflight,
      supervision: stubSupervision()
    });
    await expect(launchTool.execute("id", { name: "worker", profile: "worker", assignment: ASSIGNMENT } as never, new AbortController().signal, undefined, { cwd: "/repo" } as never)).rejects.toMatchObject({ code: "PROFILE_CATALOG_UNAVAILABLE" });
    const rendered = launchTool.renderCall?.({ name: "worker", profile: "worker" } as never, {} as never, {} as never);
    expect(rendered?.render(80)).toEqual(["herdr_launch · worker · inline · worker"]);
    rendered?.invalidate();
  });

  it("loads bundled profiles from the package scope", async () => {
    const runtime = createRuntime({ exec: async () => { throw new Error("unused"); } }, { HERDR_ENV: "1" });
    const catalog = await runtime.profiles.load();
    expect(catalog.effective.size).toBe(24);
    expect(catalog.effective.get("worker-pi")?.source.scopeRoot).toBe(process.cwd());
  });
});
