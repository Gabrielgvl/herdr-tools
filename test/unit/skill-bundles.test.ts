import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertPhysicalContainment, generateSkillBundles, loadSkillBundleRegistry, parseProfile, profileSource, resolveCanonicalSourceTree, resolveProfileRuntime, skillTreeDigest, SKILL_BUNDLE_REGISTRY_FILE, validateProfileResourceSelection } from "../../src/profiles/index.js";

function scope(label: string): string {
  return mkdtempSync(join(tmpdir(), `herdr-bundle-${label}-`));
}

function skillTree(root: string, name: string, body = "canonical body\n"): string {
  const path = join(root, name);
  mkdirSync(join(path, "references"), { recursive: true });
  writeFileSync(join(path, "SKILL.md"), body);
  writeFileSync(join(path, "references", "notes.md"), "notes\n");
  return path;
}

function piProfile(root: string, name: string, resources: string) {
  return parseProfile(`---\nname: ${name}\ndescription: ${name}\ntimeoutMinutes: 30\nsessionPersistence: false\nruntime:\n  kind: pi\n  model: test/model\n  thinking: low\n  tools: [read]\n${resources}\nfallbackProfiles: []\n---\n\nBody for ${name}.\n`, profileSource("bundled", join(root, `${name}.md`), root));
}

function registry(root: string, value: unknown): void {
  writeFileSync(join(root, SKILL_BUNDLE_REGISTRY_FILE), JSON.stringify(value, null, 2));
}

function pins(root: string): Record<string, string> {
  const document = JSON.parse(readFileSync(join(root, SKILL_BUNDLE_REGISTRY_FILE), "utf8")) as { bundles: Record<string, { treeHash: string }> };
  return Object.fromEntries(Object.entries(document.bundles).map(([key, record]) => [key, record.treeHash]));
}

async function treePaths(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true, withFileTypes: true })).map((entry) => join(entry.parentPath, entry.name)).sort();
}

describe("generated skill bundles", () => {
  it("hashes a tree deterministically from paths, executable bits, and bytes", async () => {
    const root = scope("digest");
    const left = skillTree(root, "left");
    const right = skillTree(root, "right");
    expect(await skillTreeDigest(left)).toBe(await skillTreeDigest(right));

    writeFileSync(join(right, "references", "notes.md"), "notes changed\n");
    expect(await skillTreeDigest(left)).not.toBe(await skillTreeDigest(right));

    const exec = skillTree(root, "exec");
    const same = await skillTreeDigest(exec);
    chmodSync(join(exec, "SKILL.md"), 0o755);
    expect(await skillTreeDigest(exec)).not.toBe(same);
  });

  it("refuses trees that are not plain directories of plain files", async () => {
    const root = scope("unsafe");
    const tree = skillTree(root, "tree");
    symlinkSync(join(root, "tree", "SKILL.md"), join(tree, "references", "link.md"));
    await expect(skillTreeDigest(tree)).rejects.toMatchObject({ code: "PROFILE_SKILL_TREE_UNSAFE" });

    symlinkSync(tree, join(root, "linked-tree"), "dir");
    await expect(skillTreeDigest(join(root, "linked-tree"))).rejects.toMatchObject({ code: "PROFILE_SKILL_TREE_UNSAFE" });
    await expect(skillTreeDigest(join(root, "missing"))).rejects.toMatchObject({ code: "PROFILE_SKILL_TREE_UNSAFE" });
    await expect(skillTreeDigest(join(tree, "SKILL.md"))).rejects.toMatchObject({ code: "PROFILE_SKILL_TREE_UNSAFE" });

    // A non-regular entry has no reproducible bytes to hash, so it is refused
    // rather than skipped.
    const socketTree = skillTree(root, "socket-tree");
    const server = createServer();
    await new Promise<void>((done) => server.listen(join(socketTree, "socket"), done));
    try {
      await expect(skillTreeDigest(socketTree)).rejects.toMatchObject({ code: "PROFILE_SKILL_TREE_UNSAFE", details: { path: join(socketTree, "socket") } });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it("resolves containment physically, not lexically", async () => {
    const root = scope("contain");
    const outside = scope("outside");
    skillTree(outside, "skill");
    symlinkSync(join(outside, "skill"), join(root, "escaping"), "dir");
    const inside = skillTree(root, "inside");
    await expect(assertPhysicalContainment(inside, root, "runtime resource")).resolves.toBeUndefined();
    await expect(assertPhysicalContainment(root, root, "runtime resource")).resolves.toBeUndefined();
    await expect(assertPhysicalContainment(join(root, "escaping"), root, "runtime resource")).rejects.toMatchObject({ code: "PROFILE_SKILL_PATH_ESCAPES_SCOPE" });
    await expect(assertPhysicalContainment(join(root, "missing"), root, "runtime resource")).rejects.toMatchObject({ code: "PROFILE_SKILL_PATH_ESCAPES_SCOPE" });
  });

  it("resolves an approved canonical source through its symlink to the physical tree it copies", async () => {
    const root = scope("physical");
    const approved = scope("approved-roots");
    const physical = skillTree(join(approved, "real"), "oracle");
    mkdirSync(join(approved, "farm"), { recursive: true });
    // The owner reaches canonical skills through symlink farms, so the declared
    // source is a link and the *resolved* directory is what gets hashed/copied.
    symlinkSync(physical, join(approved, "farm", "oracle"), "dir");
    const declared = join(approved, "farm", "oracle");
    expect(lstatSync(declared).isSymbolicLink()).toBe(true);

    // An approved root that does not exist approves nothing instead of
    // invalidating the whole registry.
    registry(root, { approvedSourceRoots: [join(approved, "absent"), join(approved, "farm"), join(approved, "real")], bundles: { "herdr-profiles/pi-skills/oracle": { source: declared, treeHash: "0".repeat(64) } } });
    const loaded = await loadSkillBundleRegistry(root, "bundled");
    const record = loaded.bundles.get(join(root, "herdr-profiles", "pi-skills", "oracle"))!;
    expect(record).toMatchObject({ key: "herdr-profiles/pi-skills/oracle", source: declared });
    expect(await resolveCanonicalSourceTree(record, loaded, root)).toBe(physical);

    const [generation] = await generateSkillBundles(root, "bundled");
    expect(generation).toMatchObject({ source: declared, physicalSource: physical, treeHash: await skillTreeDigest(physical), repinnedFrom: "0".repeat(64) });
    // The generated output is an ordinary whole-tree copy: same relative paths,
    // same bytes, and not one symlink or hard link back to the canonical tree.
    expect(await treePaths(generation.target)).toEqual(await treePaths(physical).then((paths) => paths.map((path) => path.replace(physical, generation.target))));
    expect(lstatSync(generation.target).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(generation.target, "SKILL.md")).nlink).toBe(1);

    // The declared source now points outside every approved root. Nothing about
    // the registry changed, so only physical resolution can catch it.
    rmSync(join(approved, "farm", "oracle"));
    const elsewhere = skillTree(scope("unapproved"), "oracle");
    symlinkSync(elsewhere, join(approved, "farm", "oracle"), "dir");
    await expect(resolveCanonicalSourceTree(record, loaded, root)).rejects.toMatchObject({ code: "PROFILE_SKILL_SOURCE_NOT_APPROVED", details: { resolved: elsewhere } });
    await expect(generateSkillBundles(root, "bundled")).rejects.toMatchObject({ code: "PROFILE_SKILL_SOURCE_NOT_APPROVED" });
  });

  it("rejects an arbitrary external source and keeps registry trust tiers separate", async () => {
    const root = scope("trust");
    const approved = scope("approved");
    const canonical = skillTree(approved, "shared");
    const pin = await skillTreeDigest(canonical);
    const target = join(root, "herdr-profiles", "pi-skills", "shared");

    const bundles = { "herdr-profiles/pi-skills/shared": { source: canonical, treeHash: pin } };
    registry(root, { approvedSourceRoots: [approved], bundles });
    for (const kind of ["bundled", "user"] as const) {
      const loaded = await loadSkillBundleRegistry(root, kind);
      expect(loaded.bundles.get(target)).toEqual({ key: "herdr-profiles/pi-skills/shared", source: canonical, treeHash: pin });
    }
    // A project-controlled registry never gets an external source at all.
    await expect(loadSkillBundleRegistry(root, "project")).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", details: { source: canonical } });

    // An absolute source outside the approved set is refused for every tier,
    // with or without approved roots declared, and a filesystem root can never
    // be the approved set.
    const arbitrary = skillTree(scope("arbitrary"), "shared");
    for (const document of [
      { approvedSourceRoots: [approved], bundles: { "herdr-profiles/pi-skills/shared": { source: arbitrary, treeHash: pin } } },
      { bundles: { "herdr-profiles/pi-skills/shared": { source: arbitrary, treeHash: pin } } },
      { approvedSourceRoots: [resolve("/")], bundles },
      { approvedSourceRoots: [canonical], bundles },
      { approvedSourceRoots: ["./relative"], bundles },
      { approvedSourceRoots: [42], bundles },
      { approvedSourceRoots: approved, bundles },
    ]) {
      registry(root, document);
      for (const kind of ["bundled", "user"] as const) await expect(loadSkillBundleRegistry(root, kind)).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_REGISTRY_INVALID" });
    }
  });

  it("rejects malformed registries and treats a missing one as no bundles", async () => {
    const root = scope("malformed");
    const pin = "0".repeat(64);
    await expect(loadSkillBundleRegistry(scope("empty"), "bundled")).resolves.toEqual({ approvedSourceRoots: [], bundles: new Map() });
    for (const value of [
      [],
      "text",
      {},
      { bundles: [] },
      { bundles: {}, extra: 1 },
      { bundles: { "../escape": { source: "./x", treeHash: pin } } },
      { bundles: { skill: { source: "./x", treeHash: "not-a-hash" } } },
      { bundles: { skill: { source: "", treeHash: pin } } },
      { bundles: { skill: { source: "./x", treeHash: pin, extra: 1 } } },
      { bundles: { skill: "./x" } },
      // Two keys that normalize to the same generated target would race each
      // other's output, so the registry is refused instead.
      { bundles: { "pi-skills/oracle": { source: "./x", treeHash: pin }, "./pi-skills/oracle": { source: "./y", treeHash: pin } } },
    ]) {
      registry(root, value);
      await expect(loadSkillBundleRegistry(root, "bundled")).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_REGISTRY_INVALID" });
    }
    writeFileSync(join(root, SKILL_BUNDLE_REGISTRY_FILE), "{ not json");
    await expect(loadSkillBundleRegistry(root, "bundled")).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_REGISTRY_INVALID" });

    // A registry that exists but cannot be read is invalid, not absent.
    rmSync(join(root, SKILL_BUNDLE_REGISTRY_FILE));
    mkdirSync(join(root, SKILL_BUNDLE_REGISTRY_FILE));
    await expect(loadSkillBundleRegistry(root, "bundled")).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_REGISTRY_INVALID" });
  });

  it("regenerates deterministically, repins canonical drift, and fails launch closed until it does", async () => {
    const root = scope("generate");
    const approved = scope("canonical");
    const canonical = skillTree(approved, "oracle");
    const key = "herdr-profiles/pi-skills/oracle";
    registry(root, { approvedSourceRoots: [approved], bundles: { [key]: { source: canonical, treeHash: "0".repeat(64) } } });

    const first = await generateSkillBundles(root, "bundled");
    const target = join(root, "herdr-profiles", "pi-skills", "oracle");
    const pin = await skillTreeDigest(canonical);
    expect(first).toEqual([{ target, source: canonical, physicalSource: canonical, treeHash: pin, repinnedFrom: "0".repeat(64) }]);
    expect(pins(root)).toEqual({ [key]: pin });
    expect(readFileSync(join(target, "references", "notes.md"), "utf8")).toBe("notes\n");

    // Deterministic: a second generation from the same source reproduces the
    // same digest and moves no pin.
    expect(await generateSkillBundles(root, "bundled")).toEqual([{ target, source: canonical, physicalSource: canonical, treeHash: pin }]);
    expect(pins(root)).toEqual({ [key]: pin });

    const bundled = piProfile(root, "bundled-profile", `  skills: [./${key}]`);
    await expect(validateProfileResourceSelection(bundled, bundled.runtime)).resolves.toBeUndefined();

    // A tampered generated copy is stale, never repaired at launch.
    writeFileSync(join(target, "SKILL.md"), "tampered\n");
    await expect(validateProfileResourceSelection(bundled, bundled.runtime)).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_STALE", details: { path: target, expected: pin } });
    await generateSkillBundles(root, "bundled");
    await expect(validateProfileResourceSelection(bundled, bundled.runtime)).resolves.toBeUndefined();

    // Canonical drift fails launch closed while the committed copy and pin are
    // both still internally consistent; only a rebuild repins and re-materializes.
    writeFileSync(join(canonical, "SKILL.md"), "canonical drifted\n");
    const drifted = await skillTreeDigest(canonical);
    await expect(validateProfileResourceSelection(bundled, bundled.runtime)).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_STALE", details: { path: canonical, expected: pin, actual: drifted } });
    expect(await generateSkillBundles(root, "bundled")).toEqual([{ target, source: canonical, physicalSource: canonical, treeHash: drifted, repinnedFrom: pin }]);
    expect(pins(root)).toEqual({ [key]: drifted });
    await expect(validateProfileResourceSelection(bundled, bundled.runtime)).resolves.toBeUndefined();

    // A canonical source that has gone missing is a hard failure on both sides.
    renameSync(canonical, join(approved, "moved"));
    await expect(validateProfileResourceSelection(bundled, bundled.runtime)).rejects.toMatchObject({ code: "PROFILE_SKILL_TREE_UNSAFE", details: { path: canonical } });
    await expect(generateSkillBundles(root, "bundled")).rejects.toMatchObject({ code: "PROFILE_SKILL_TREE_UNSAFE", details: { path: canonical } });
  });

  it("keeps the package registry generated, pinned, and sourced from the approved canonical trees", async () => {
    const packageRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
    const registry = await loadSkillBundleRegistry(packageRoot, "bundled");
    expect(registry.bundles.size).toBeGreaterThan(0);
    expect(registry.approvedSourceRoots.length).toBeGreaterThan(0);
    // The only in-package canonical sources are the two tracked manager role
    // skills the generated manager profile plugin re-materializes. Everything
    // else is an external owner-approved tree, never a hand-maintained copy.
    const inPackage = [...registry.bundles.values()].filter((record) => record.source.startsWith(packageRoot + sep)).map((record) => relative(packageRoot, record.source)).sort();
    expect(inPackage).toEqual([
      join("herdr-profiles", "role-plugins", "manager", "skills", "harness-flow"),
      join("herdr-profiles", "role-plugins", "manager", "skills", "manager")
    ]);
    for (const [target, record] of registry.bundles) {
      const physical = await resolveCanonicalSourceTree(record, registry, packageRoot);
      // Generated copy and current canonical source must both still match the
      // pin, which is exactly the check launch preflight runs.
      expect(await skillTreeDigest(target)).toBe(record.treeHash);
      expect(await skillTreeDigest(physical)).toBe(record.treeHash);
    }
  });

  it("rejects duplicate skill names and validates every scoped resource kind", async () => {
    const root = scope("selection");
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    skillTree(join(root, "a"), "worker");
    skillTree(join(root, "b"), "worker");
    const duplicate = piProfile(root, "duplicate-profile", "  skills: [./a/worker, ./b/worker]");
    await expect(validateProfileResourceSelection(duplicate, duplicate.runtime)).rejects.toMatchObject({ code: "PROFILE_SKILL_TREE_UNSAFE", details: { profile: "duplicate-profile" } });

    // An unregistered in-scope skill needs no pin, only physical safety.
    const plain = piProfile(root, "plain-profile", "  skills: [./a/worker]");
    await expect(validateProfileResourceSelection(plain, plain.runtime)).resolves.toBeUndefined();

    // Extensions are containment-checked but are not skill trees.
    writeFileSync(join(root, "ext.ts"), "export default 1;\n");
    const withExtension = piProfile(root, "extension-profile", "  extensions: [./ext.ts]\n  skills: [./a/worker]");
    await expect(validateProfileResourceSelection(withExtension, resolveProfileRuntime(withExtension))).resolves.toBeUndefined();

    // AGY contributes no skill trees, so nothing is selected or mutated for it.
    const agy = parseProfile(`---\nname: agy-profile\ndescription: agy-profile\ntimeoutMinutes: 30\nsessionPersistence: true\nruntime:\n  kind: agy\n  model: gemini-3.8-flash-high\n  mode: plan\n  addDirs: []\nfallbackProfiles: []\n---\n\nBody for agy-profile.\n`, profileSource("bundled", join(root, "agy-profile.md"), root));
    await expect(validateProfileResourceSelection(agy, agy.runtime)).resolves.toBeUndefined();
  });

  it("validates every pin nested inside a selected Claude plugin root", async () => {
    const root = scope("plugin");
    const approved = scope("plugin-canonical");
    const canonical = skillTree(approved, "oracle");
    const key = "herdr-profiles/profile-plugins/manager/skills/oracle";
    registry(root, { approvedSourceRoots: [approved], bundles: { [key]: { source: canonical, treeHash: "0".repeat(64) } } });
    const [generation] = await generateSkillBundles(root, "bundled");
    const pin = await skillTreeDigest(canonical);
    expect(generation.treeHash).toBe(pin);

    // The plugin root itself is never a registered target; the profile selects
    // the root and the registry pins the skills nested inside it.
    const pluginRoot = join(root, "herdr-profiles", "profile-plugins", "manager");
    mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
    writeFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: "manager" })}\n`);
    const plugin = parseProfile(`---\nname: plugin-profile\ndescription: plugin-profile\ntimeoutMinutes: 30\nsessionPersistence: true\nruntime:\n  kind: claude\n  model: test/model\n  effort: low\n  pluginDirs: [./herdr-profiles/profile-plugins/manager]\nfallbackProfiles: []\n---\n\nBody for plugin-profile.\n`, profileSource("bundled", join(root, "plugin-profile.md"), root));
    await expect(validateProfileResourceSelection(plugin, plugin.runtime)).resolves.toBeUndefined();

    // Tampering *inside* a nested generated skill must fail the selected plugin
    // root closed, even though the root carries no pin of its own.
    writeFileSync(join(generation.target, "SKILL.md"), "tampered\n");
    await expect(validateProfileResourceSelection(plugin, plugin.runtime)).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_STALE", details: { path: generation.target, expected: pin } });
    await generateSkillBundles(root, "bundled");
    await expect(validateProfileResourceSelection(plugin, plugin.runtime)).resolves.toBeUndefined();

    // Canonical drift behind a nested pin is caught through the same selection.
    writeFileSync(join(canonical, "SKILL.md"), "drifted\n");
    await expect(validateProfileResourceSelection(plugin, plugin.runtime)).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_STALE", details: { path: canonical, expected: pin } });

    // A pin for a bundle this profile does not select is not this profile's
    // problem: only pins at or under a selected tree are validated.
    const unrelated = "herdr-profiles/pi-skills/elsewhere";
    registry(root, { approvedSourceRoots: [approved], bundles: { [key]: { source: canonical, treeHash: pin }, [unrelated]: { source: canonical, treeHash: "0".repeat(64) } } });
    writeFileSync(join(canonical, "SKILL.md"), "canonical body\n");
    await expect(validateProfileResourceSelection(plugin, plugin.runtime)).resolves.toBeUndefined();
  });

  it("rejects two skill trees whose SKILL.md declares the same name", async () => {
    const root = scope("declared");
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    // Distinct directory names, one declared runtime name: a basename-only
    // check cannot see this collision.
    skillTree(join(root, "a"), "left", "---\nname: shared-skill\ndescription: left\n---\n\nBody.\n");
    skillTree(join(root, "b"), "right", "---\nname: shared-skill\ndescription: right\n---\n\nBody.\n");
    const duplicate = piProfile(root, "declared-profile", "  skills: [./a/left, ./b/right]");
    await expect(validateProfileResourceSelection(duplicate, duplicate.runtime)).rejects.toMatchObject({ code: "PROFILE_SKILL_TREE_UNSAFE", details: { names: ["shared-skill", "shared-skill"] } });

    // The same collision across a Pi skill and a skill nested in a selected
    // plugin root is the same failure.
    mkdirSync(join(root, "plugin", "skills"), { recursive: true });
    skillTree(join(root, "plugin", "skills"), "nested", "---\nname: shared-skill\ndescription: nested\n---\n\nBody.\n");
    const mixed = piProfile(root, "mixed-profile", "  skills: [./a/left, ./plugin]");
    await expect(validateProfileResourceSelection(mixed, mixed.runtime)).rejects.toMatchObject({ code: "PROFILE_SKILL_TREE_UNSAFE", details: { names: ["shared-skill", "shared-skill"] } });

    // Distinct declared names pass even when the directory names collide.
    mkdirSync(join(root, "c"), { recursive: true });
    skillTree(join(root, "c"), "left", "---\nname: other-skill\ndescription: other\n---\n\nBody.\n");
    const distinct = piProfile(root, "distinct-profile", "  skills: [./a/left, ./c/left]");
    await expect(validateProfileResourceSelection(distinct, distinct.runtime)).resolves.toBeUndefined();

    // A tree that declares no usable name falls back to its directory name,
    // because that is what the runtime then resolves it by, so the collision is
    // still caught. Frontmatter whose `name` is not a usable string is one such
    // tree.
    mkdirSync(join(root, "d"), { recursive: true });
    skillTree(join(root, "d"), "unnamed", "---\nname: 42\ndescription: unnamed\n---\n\nBody.\n");
    skillTree(join(root, "c"), "unnamed", "---\nname: []\ndescription: unnamed\n---\n\nBody.\n");
    const unnamed = piProfile(root, "unnamed-profile", "  skills: [./c/unnamed, ./d/unnamed]");
    await expect(validateProfileResourceSelection(unnamed, unnamed.runtime)).rejects.toMatchObject({ code: "PROFILE_SKILL_TREE_UNSAFE", details: { names: ["unnamed", "unnamed"] } });

    // A plugin skill with no `SKILL.md`, and a directory that is neither a
    // skill nor a plugin root, are both named by their directory too.
    mkdirSync(join(root, "bare-plugin", "skills", "nameless"), { recursive: true });
    mkdirSync(join(root, "e", "nameless"), { recursive: true });
    // A stray file beside the plugin's skill directories is not a skill.
    writeFileSync(join(root, "bare-plugin", "skills", "README.md"), "not a skill\n");
    const bare = piProfile(root, "bare-profile", "  skills: [./bare-plugin, ./e/nameless]");
    await expect(validateProfileResourceSelection(bare, bare.runtime)).rejects.toMatchObject({ code: "PROFILE_SKILL_TREE_UNSAFE", details: { names: ["nameless", "nameless"] } });
  });

  it("refuses generated targets that would destroy the scope root or authoritative content", async () => {
    const root = scope("targets");
    const canonical = skillTree(join(root, "canonical"), "worker");
    const pin = await skillTreeDigest(canonical);
    const source = "./canonical/worker";
    // A target must be nested below a top-level scope entry, so neither the
    // scope root nor any top-level authoritative file or directory is reachable.
    for (const key of [".", "./", "package.json", SKILL_BUNDLE_REGISTRY_FILE, "src", "./src"]) {
      registry(root, { bundles: { [key]: { source, treeHash: pin } } });
      await expect(loadSkillBundleRegistry(root, "bundled")).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_REGISTRY_INVALID" });
      await expect(generateSkillBundles(root, "bundled")).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_REGISTRY_INVALID" });
    }

    // One target nested inside another would have the outer generation destroy
    // the inner one, so the pair is refused rather than left order-dependent.
    registry(root, { bundles: { "herdr-profiles/pi-skills": { source, treeHash: pin }, "herdr-profiles/pi-skills/worker": { source, treeHash: pin } } });
    await expect(loadSkillBundleRegistry(root, "bundled")).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_REGISTRY_INVALID" });

    // An authoritative *file* nested deep enough to pass the target rule is
    // still refused, before any removal or rename runs.
    mkdirSync(join(root, "herdr-profiles"), { recursive: true });
    writeFileSync(join(root, "herdr-profiles", "worker-pi.md"), "authoritative\n");
    registry(root, { bundles: { "herdr-profiles/worker-pi.md": { source, treeHash: pin } } });
    await expect(generateSkillBundles(root, "bundled")).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", details: { path: join(root, "herdr-profiles", "worker-pi.md") } });
    expect(readFileSync(join(root, "herdr-profiles", "worker-pi.md"), "utf8")).toBe("authoritative\n");

    // A registry naming one bad target destroys nothing at all, not even the
    // good targets it lists alongside it.
    registry(root, { bundles: { "herdr-profiles/pi-skills/worker": { source, treeHash: pin }, "herdr-profiles/worker-pi.md": { source, treeHash: pin } } });
    await expect(generateSkillBundles(root, "bundled")).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_REGISTRY_INVALID" });
    expect(existsSync(join(root, "herdr-profiles", "pi-skills", "worker"))).toBe(false);

    // Only a genuinely absent target is a first generation. A target that
    // cannot be inspected at all is not proven replaceable, so generation stops
    // instead of removing it blind. Here its parent is a file, so the stat
    // fails with ENOTDIR rather than ENOENT.
    writeFileSync(join(root, "herdr-profiles", "blocked"), "not a directory\n");
    registry(root, { bundles: { "herdr-profiles/blocked/worker": { source, treeHash: pin } } });
    await expect(generateSkillBundles(root, "bundled")).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", details: { path: join(root, "herdr-profiles", "blocked", "worker") } });
    expect(readFileSync(join(root, "herdr-profiles", "blocked"), "utf8")).toBe("not a directory\n");
  });

  it("refuses an approved source root that physically resolves to a filesystem root", async () => {
    const root = scope("root-link");
    const approved = scope("root-link-approved");
    const canonical = skillTree(approved, "worker");
    const pin = await skillTreeDigest(canonical);
    // Lexically an ordinary absolute directory, physically `/`. Accepting its
    // realpath would approve every tree on the machine.
    symlinkSync(resolve("/"), join(approved, "as-root"), "dir");
    // Declared lexically inside that approved root, so load accepts it; only
    // physical resolution of the *root* can catch the escape.
    const source = join(approved, "as-root", relative(resolve("/"), canonical));
    const key = "herdr-profiles/pi-skills/worker";
    registry(root, { approvedSourceRoots: [join(approved, "as-root")], bundles: { [key]: { source, treeHash: pin } } });
    const loaded = await loadSkillBundleRegistry(root, "bundled");
    expect(loaded.approvedSourceRoots).toEqual([join(approved, "as-root")]);
    const record = loaded.bundles.get(join(root, "herdr-profiles", "pi-skills", "worker"))!;
    await expect(resolveCanonicalSourceTree(record, loaded, root)).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", details: { resolved: resolve("/") } });
    await expect(generateSkillBundles(root, "bundled")).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_REGISTRY_INVALID" });
  });

  it("materializes an in-scope relative source without approving anything external", async () => {
    const root = scope("relative");
    const canonical = skillTree(join(root, "canonical"), "worker");
    registry(root, { bundles: { "herdr-profiles/pi-skills/worker": { source: "./canonical/worker", treeHash: "0".repeat(64) } } });
    const [generation] = await generateSkillBundles(root, "bundled");
    expect(generation).toMatchObject({ physicalSource: canonical, treeHash: await skillTreeDigest(canonical) });

    // A relative source that leaves the scope root is refused lexically, and one
    // that leaves it only through a symlink is refused physically.
    registry(root, { bundles: { "herdr-profiles/pi-skills/worker": { source: "../elsewhere", treeHash: "0".repeat(64) } } });
    await expect(loadSkillBundleRegistry(root, "bundled")).rejects.toMatchObject({ code: "PROFILE_SKILL_BUNDLE_REGISTRY_INVALID" });

    symlinkSync(skillTree(scope("relative-outside"), "worker"), join(root, "linked"), "dir");
    registry(root, { bundles: { "herdr-profiles/pi-skills/worker": { source: "./linked", treeHash: "0".repeat(64) } } });
    await expect(generateSkillBundles(root, "bundled")).rejects.toMatchObject({ code: "PROFILE_SKILL_PATH_ESCAPES_SCOPE" });
  });
});
