import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeScopedResourcePath, parseFrontmatter } from "./parser.js";
import type { Profile, ProfileSourceKind, RuntimeProfile } from "./types.js";

/**
 * Generated skill bundles let a profile select a canonical skill that lives
 * outside its own scope root without ever widening the containment boundary:
 * the canonical tree is copied whole into the profile scope at build time and
 * pinned by a deterministic tree hash. Launch only validates; it never
 * generates, repairs, or dereferences anything.
 */
export const SKILL_BUNDLE_REGISTRY_FILE = "herdr-skill-bundles.json";

export type SkillSelectionCode =
  | "PROFILE_SKILL_PATH_ESCAPES_SCOPE"
  | "PROFILE_SKILL_TREE_UNSAFE"
  | "PROFILE_SKILL_SOURCE_NOT_APPROVED"
  | "PROFILE_SKILL_BUNDLE_STALE"
  | "PROFILE_SKILL_BUNDLE_REGISTRY_INVALID";

export class SkillSelectionError extends Error {
  constructor(readonly code: SkillSelectionCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SkillSelectionError";
  }
}

export interface SkillBundleRecord {
  /** Registry key exactly as declared, relative to the scope root. */
  key: string;
  /** Canonical source tree the generated copy is taken from. Absolute when external. */
  source: string;
  /** Pinned SHA-256 of the deterministic tree hash, as of the last generation. */
  treeHash: string;
}

export interface SkillBundleRegistry {
  /**
   * The approved external source set. An absolute canonical source is accepted
   * only from strictly inside one of these roots, both lexically at load and
   * physically after `realpath` at generation and launch. An empty list means
   * this scope approves no external source at all.
   */
  approvedSourceRoots: readonly string[];
  /** Generated target (absolute, inside the scope root) -> pinned record. */
  bundles: ReadonlyMap<string, SkillBundleRecord>;
}

export interface SkillBundleGeneration {
  /** Generated whole-tree copy inside the profile scope. */
  target: string;
  /** Canonical source exactly as declared in the registry. */
  source: string;
  /** The physical directory the declared source resolves to through `realpath`. */
  physicalSource: string;
  /** Digest of the canonical source and of the generated copy. */
  treeHash: string;
  /** Previous pin when generation moved it, so a repin is never silent. */
  repinnedFrom?: string;
}

interface TreeFile {
  rel: string;
  path: string;
  exec: boolean;
}

function fail(code: SkillSelectionCode, message: string, details: Record<string, unknown> = {}): never {
  throw new SkillSelectionError(code, message, details);
}

function escapes(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
}

/** Strictly inside: a source equal to an approved root would bundle the whole root. */
function strictlyInside(root: string, path: string): boolean {
  return path !== root && !escapes(root, path);
}

async function collect(root: string, directory: string, files: TreeFile[]): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  // UTF-8 byte order, so the digest is reproducible on any platform and does
  // not depend on locale collation or on the order the filesystem listed.
  for (const entry of entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
    const path = join(directory, entry.name);
    // A symbolic link is refused rather than resolved: it makes the tree hash
    // depend on state outside the tree and is the exact shape a lexical scope
    // check cannot see. Only the declared source *root* may be a symlink, and
    // that one is resolved to its physical directory before hashing.
    if (entry.isSymbolicLink()) fail("PROFILE_SKILL_TREE_UNSAFE", "skill tree contains a symbolic link", { path });
    if (entry.isDirectory()) {
      await collect(root, path, files);
      continue;
    }
    if (!entry.isFile()) fail("PROFILE_SKILL_TREE_UNSAFE", "skill tree contains a non-regular file", { path });
    const stat = await fs.lstat(path);
    files.push({ rel: relative(root, path).split(sep).join("/"), path, exec: (stat.mode & 0o111) !== 0 });
  }
}

/**
 * Deterministic SHA-256 over relative path, executable bit, and exact bytes of
 * every regular file in the tree, in sorted path order. No mtime, size-only, or
 * inode input, so the digest is reproducible from the canonical source alone.
 */
export async function skillTreeDigest(root: string): Promise<string> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(root);
  } catch (error) {
    fail("PROFILE_SKILL_TREE_UNSAFE", "skill tree is missing", { path: root, cause: String(error) });
  }
  if (stat.isSymbolicLink()) fail("PROFILE_SKILL_TREE_UNSAFE", "skill tree root is a symbolic link", { path: root });
  if (!stat.isDirectory()) fail("PROFILE_SKILL_TREE_UNSAFE", "skill tree root is not a directory", { path: root });
  const files: TreeFile[] = [];
  await collect(root, root, files);
  const hash = createHash("sha256");
  for (const file of files) {
    const contents = await fs.readFile(file.path);
    hash.update(`${file.rel}\0${file.exec ? "1" : "0"}\0${contents.byteLength}\0`);
    hash.update(contents);
  }
  return hash.digest("hex");
}

/**
 * Physical containment. `normalizeScopedResourcePath` is lexical only, so a
 * symlinked resource directory can satisfy it while pointing outside the scope
 * root. Both sides are resolved through `realpath` before comparison.
 */
export async function assertPhysicalContainment(path: string, scopeRoot: string, field: string): Promise<void> {
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = await fs.realpath(scopeRoot);
    realPath = await fs.realpath(path);
  } catch (error) {
    fail("PROFILE_SKILL_PATH_ESCAPES_SCOPE", `${field} cannot be physically resolved`, { path, scopeRoot, cause: String(error) });
  }
  if (escapes(realRoot, realPath)) fail("PROFILE_SKILL_PATH_ESCAPES_SCOPE", `${field} escapes the profile scope root after symlink resolution`, { path, resolved: realPath, scopeRoot: realRoot });
}

function approvedSourceRoots(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "approvedSourceRoots must be an array of absolute paths");
  return value.map((item) => {
    if (typeof item !== "string" || item.length === 0 || /[\0\r\n]/.test(item)) fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "approvedSourceRoots entries must be non-empty single-line paths");
    if (!isAbsolute(item)) fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "approvedSourceRoots entries must be absolute paths", { root: item });
    const root = resolve(item);
    // A filesystem root is not an approved *set*; it would authorize everything.
    if (dirname(root) === root) fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "approvedSourceRoots entries must not be a filesystem root", { root });
    return root;
  });
}

/**
 * A generated target is disposable content that generation recursively removes
 * and replaces, so the registry may only name a directory nested *below* a
 * top-level entry of the scope. That refuses the scope root itself (`.`, which
 * would replace the whole package with one skill tree) and every top-level
 * authoritative entry (`package.json`, this registry, `src`, `test`), before
 * any removal or rename can run.
 */
function generatedTarget(scopeRoot: string, key: string): string {
  const root = resolve(scopeRoot);
  let target: string;
  try {
    target = normalizeScopedResourcePath(key, `${SKILL_BUNDLE_REGISTRY_FILE} key`, root);
  } catch (error) {
    fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", (error as Error).message, { key });
  }
  if (relative(root, target).split(sep).length < 2) fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "skill bundle target must be a directory nested below a top-level entry of the profile scope root", { key, target, scopeRoot: root });
  return target;
}

function registryRecord(scopeRoot: string, sourceKind: ProfileSourceKind, roots: readonly string[], key: string, value: unknown): [string, SkillBundleRecord] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "skill bundle record must be an object", { key });
  const entry = value as Record<string, unknown>;
  for (const field of Object.keys(entry)) if (field !== "source" && field !== "treeHash") fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", `skill bundle record contains unknown field ${field}`, { key });
  const { source, treeHash } = entry;
  if (typeof treeHash !== "string" || !/^[0-9a-f]{64}$/.test(treeHash)) fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "skill bundle treeHash must be a lowercase SHA-256 hex digest", { key });
  if (typeof source !== "string" || source.length === 0 || /[\0\r\n]/.test(source)) fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "skill bundle source must be a non-empty single-line path", { key });
  const target = generatedTarget(scopeRoot, key);
  if (!isAbsolute(source)) {
    let resolvedSource: string;
    try {
      resolvedSource = normalizeScopedResourcePath(source, `${SKILL_BUNDLE_REGISTRY_FILE} source`, scopeRoot);
    } catch (error) {
      fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", (error as Error).message, { key });
    }
    return [target, { key, source: resolvedSource, treeHash }];
  }
  // An external canonical source is a trust decision, not a path convenience.
  // A project-controlled registry never gets one, and the owner-owned bundled
  // and user registries get one only from inside their own approved source set,
  // so an arbitrary absolute path is refused even there.
  if (sourceKind === "project") fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "a project-scope skill bundle source must be relative to the project scope root", { key, source });
  const external = resolve(source);
  if (!roots.some((root) => strictlyInside(root, external))) fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "skill bundle source is outside every approved source root", { key, source: external, approvedSourceRoots: roots });
  return [target, { key, source: external, treeHash }];
}

/**
 * Reads the trust-tier registry at the profile scope root. A missing file means
 * this scope registers no generated bundles, which is the normal case.
 */
export async function loadSkillBundleRegistry(scopeRoot: string, sourceKind: ProfileSourceKind): Promise<SkillBundleRegistry> {
  const path = join(resolve(scopeRoot), SKILL_BUNDLE_REGISTRY_FILE);
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { approvedSourceRoots: [], bundles: new Map() };
    return fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "skill bundle registry is unreadable", { path, cause: String(error) });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "skill bundle registry is not valid JSON", { path, cause: String(error) });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "skill bundle registry must be a JSON object", { path });
  const document = parsed as Record<string, unknown>;
  for (const field of Object.keys(document)) if (field !== "approvedSourceRoots" && field !== "bundles") fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", `skill bundle registry contains unknown field ${field}`, { path });
  const roots = approvedSourceRoots(document.approvedSourceRoots);
  const declared = document.bundles;
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "skill bundle registry must declare a bundles object", { path });
  const bundles = new Map<string, SkillBundleRecord>();
  for (const [key, value] of Object.entries(declared as Record<string, unknown>)) {
    const [target, record] = registryRecord(scopeRoot, sourceKind, roots, key, value);
    if (bundles.has(target)) fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "skill bundle registry declares the same generated path twice", { path, key });
    bundles.set(target, record);
  }
  // One target nested inside another means generating the outer one destroys
  // the inner one, so the pair is refused rather than left order-dependent.
  // ponytail: O(n²) over a hand-written registry's few dozen keys.
  for (const outer of bundles.keys()) {
    for (const inner of bundles.keys()) {
      if (outer !== inner && !escapes(outer, inner)) fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "skill bundle registry declares a generated path nested inside another", { path, outer, inner });
    }
  }
  return { approvedSourceRoots: roots, bundles };
}

async function physicalRoots(roots: readonly string[]): Promise<string[]> {
  const physical: string[] = [];
  for (const root of roots) {
    // An approved root that cannot be resolved physically contains nothing, so
    // it simply approves nothing rather than invalidating the whole registry.
    let resolved: string;
    try {
      resolved = await fs.realpath(root);
    } catch {
      continue;
    }
    // The lexical check at load is not enough: an approved root may itself be a
    // symlink whose physical target is a filesystem root, which would authorize
    // every tree on the machine. That is a misconfigured trust boundary, not an
    // unapproved source, so it is reported as such instead of silently
    // approving nothing.
    if (dirname(resolved) === resolved) fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "approvedSourceRoots entry resolves to a filesystem root", { root, resolved });
    physical.push(resolved);
  }
  return physical;
}

/**
 * Resolves the declared canonical source to the physical directory that is
 * actually hashed and copied. The canonical trees are reached through owner
 * symlink farms, so the declared path may be a symlink; the *resolved* path is
 * what must satisfy the approved source set or the scope root, which is what
 * makes a repointed symlink an escape rather than a silent redirect.
 */
export async function resolveCanonicalSourceTree(record: SkillBundleRecord, registry: SkillBundleRegistry, scopeRoot: string): Promise<string> {
  const root = resolve(scopeRoot);
  let physical: string;
  try {
    physical = await fs.realpath(record.source);
  } catch (error) {
    fail("PROFILE_SKILL_TREE_UNSAFE", "canonical skill source is missing", { key: record.key, path: record.source, cause: String(error) });
  }
  if (escapes(root, resolve(record.source))) {
    const roots = await physicalRoots(registry.approvedSourceRoots);
    if (!roots.some((approved) => strictlyInside(approved, physical))) {
      fail("PROFILE_SKILL_SOURCE_NOT_APPROVED", "canonical skill source resolves outside every approved source root", { key: record.key, path: record.source, resolved: physical, approvedSourceRoots: roots });
    }
    return physical;
  }
  await assertPhysicalContainment(physical, root, `${SKILL_BUNDLE_REGISTRY_FILE} source`);
  return physical;
}

function scopedResourcePaths(runtime: RuntimeProfile): string[] {
  if (runtime.kind === "pi") return [...runtime.extensions, ...runtime.skills];
  if (runtime.kind === "claude") return [...runtime.addDirs, ...runtime.pluginDirs];
  return [...runtime.addDirs];
}

/**
 * The skill trees a runtime actually loads. Pi receives an exact allowlist of
 * skill directories; Claude receives selected plugin directories additively.
 * AGY has no per-session selector, so it contributes none and Herdr never
 * mutates global or project skill state to compensate.
 */
function selectedSkillTrees(runtime: RuntimeProfile): string[] {
  if (runtime.kind === "pi") return [...runtime.skills];
  if (runtime.kind === "claude") return [...runtime.pluginDirs];
  return [];
}

/**
 * The `name` a skill directory's `SKILL.md` declares, which is the name the
 * runtime actually resolves the skill by. `undefined` means the directory
 * declares no skill of its own, which is how a plugin root is told apart from a
 * skill directory. Frontmatter that is present but unusable falls back to the
 * directory name rather than passing an unchecked collision through.
 */
async function declaredSkillName(directory: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await fs.readFile(join(directory, "SKILL.md"), "utf8");
  } catch {
    return undefined;
  }
  try {
    const { name } = parseFrontmatter(text).values;
    return typeof name === "string" && name.length > 0 ? name : basename(directory);
  } catch {
    return basename(directory);
  }
}

/**
 * The runtime skill names one selection exposes. A Pi selection is itself a
 * skill directory; a Claude selection is a plugin root whose `skills/<name>`
 * children are the skills the runtime loads. Both shapes yield declared names,
 * so a collision between a Pi skill and a skill nested in a selected plugin,
 * or between two differently named directories declaring the same `name`, is
 * caught by one check.
 */
async function selectedSkillNames(tree: string): Promise<string[]> {
  const declared = await declaredSkillName(tree);
  if (declared !== undefined) return [declared];
  const names: string[] = [];
  try {
    for (const entry of await fs.readdir(join(tree, "skills"), { withFileTypes: true })) {
      if (entry.isDirectory()) names.push((await declaredSkillName(join(tree, "skills", entry.name))) ?? entry.name);
    }
  } catch {
    // Neither a skill directory nor a plugin root: the directory name is all
    // the runtime can see.
  }
  return names.length > 0 ? names : [basename(tree)];
}

/**
 * Fail-closed validation of one reachable profile's resource selection. Callers
 * must run this for every reachable fallback profile before the first launch
 * effect, because there is no automatic repair.
 */
export async function validateProfileResourceSelection(profile: Profile, runtime: RuntimeProfile): Promise<void> {
  const scopeRoot = profile.source.scopeRoot;
  for (const path of scopedResourcePaths(runtime)) await assertPhysicalContainment(path, scopeRoot, "runtime resource");
  const trees = selectedSkillTrees(runtime);
  if (trees.length === 0) return;
  const names = (await Promise.all(trees.map((tree) => selectedSkillNames(tree)))).flat();
  if (new Set(names).size !== names.length) fail("PROFILE_SKILL_TREE_UNSAFE", "profile selects two skill trees with the same name", { profile: profile.name, names });
  const registry = await loadSkillBundleRegistry(scopeRoot, profile.source.kind);
  for (const tree of trees) {
    // Every selected tree is hashed, registered or not, so an ordinary in-scope
    // skill tree cannot smuggle in a symlink or a non-regular file either.
    const generated = await skillTreeDigest(tree);
    // A Pi selection *is* the registered target, but a Claude selection is a
    // plugin root and the registry pins the generated skill trees nested inside
    // it, so every pin at or under the selection is checked. Missing that
    // nesting would let a tampered generated skill inside a selected plugin
    // launch unvalidated.
    for (const [target, record] of registry.bundles) {
      if (escapes(tree, target)) continue;
      const digest = target === tree ? generated : await skillTreeDigest(target);
      if (digest !== record.treeHash) fail("PROFILE_SKILL_BUNDLE_STALE", "generated skill bundle does not match its pinned tree hash", { profile: profile.name, path: target, expected: record.treeHash, actual: digest });
      const physical = await resolveCanonicalSourceTree(record, registry, scopeRoot);
      const canonical = await skillTreeDigest(physical);
      if (canonical !== record.treeHash) fail("PROFILE_SKILL_BUNDLE_STALE", "canonical skill source does not match its pinned tree hash", { profile: profile.name, path: record.source, resolved: physical, expected: record.treeHash, actual: canonical });
    }
  }
}

/** Rewrites only the pins, in place, so the registry's reviewed policy and its declared key order survive a repin. */
async function writePins(scopeRoot: string, pins: ReadonlyMap<string, string>): Promise<void> {
  const path = join(resolve(scopeRoot), SKILL_BUNDLE_REGISTRY_FILE);
  const document = JSON.parse(await fs.readFile(path, "utf8")) as { bundles: Record<string, { source: string; treeHash: string }> };
  for (const [key, treeHash] of pins) document.bundles[key].treeHash = treeHash;
  await fs.writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

/**
 * Build/install-time generation. Generated content is disposable and is never
 * hand-edited or produced during a launch. The pin is a derived build artifact:
 * generation recomputes it from the canonical source at that moment, so the
 * reviewed policy in the registry is the target/source/approved-root mapping,
 * and the pin's job is to fail launch closed on any drift or tampering that
 * happens *after* the build.
 */
export async function generateSkillBundles(scopeRoot: string, sourceKind: ProfileSourceKind): Promise<SkillBundleGeneration[]> {
  const root = resolve(scopeRoot);
  const registry = await loadSkillBundleRegistry(root, sourceKind);
  // Every target is proven replaceable before the first destructive step, so a
  // registry that names an authoritative *file* inside a generated directory
  // cannot destroy it, and cannot leave the scope half-replaced either.
  for (const target of registry.bundles.keys()) {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      // Only a genuinely absent target is a first generation. Any other stat
      // failure means the target cannot be inspected, so it is not proven
      // replaceable and generation stops instead of removing it blind.
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      return fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "skill bundle target cannot be inspected", { path: target, cause: String(error) });
    }
    if (!stat.isDirectory()) fail("PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "skill bundle target exists and is not a generated directory", { path: target });
  }
  const generations: SkillBundleGeneration[] = [];
  const pins = new Map<string, string>();
  for (const [target, record] of registry.bundles) {
    const physical = await resolveCanonicalSourceTree(record, registry, root);
    const treeHash = await skillTreeDigest(physical);
    const staging = `${target}.herdr-staging`;
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(dirname(target), { recursive: true });
    try {
      // An ordinary whole-tree copy: the source tree has already been proven
      // free of symlinks and non-regular files by the digest above, so the
      // generated output is plain directories and plain files.
      await fs.cp(physical, staging, { recursive: true, dereference: false });
      const copied = await skillTreeDigest(staging);
      /* c8 ignore next -- a whole-tree copy of an already-digested plain tree can only differ if the source changed mid-build, which launch then catches against the pin. */
      if (copied !== treeHash) fail("PROFILE_SKILL_BUNDLE_STALE", "generated skill bundle copy does not match its canonical source", { path: target, expected: treeHash, actual: copied });
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(staging, target);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
    if (treeHash !== record.treeHash) pins.set(record.key, treeHash);
    generations.push({ target, source: record.source, physicalSource: physical, treeHash, ...(treeHash === record.treeHash ? {} : { repinnedFrom: record.treeHash }) });
  }
  if (pins.size > 0) await writePins(root, pins);
  return generations;
}
