import { promises as fs } from "node:fs";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CATALOG_PATH, CatalogError, ChainResolutionError, DEFAULT_MAX_ATTEMPTS, loadCatalog, parseCatalog, quotaKeyFor, resolveChain, type Catalog, type ChainCandidate } from "../../src/catalog.js";

const SCOPE = "/catalog-scope";
const SOURCE = { path: `${SCOPE}/herdr-profiles/catalog.yaml`, scopeRoot: SCOPE };
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const VALID = `version: 1
maxAttempts: 4
categories:
  frontier:
    - {runner: devin, model: swe-2-max}
    - {runner: claude, model: claude-opus-5}
    - {runner: pi, model: test/pi-pro}
    - {runner: claude, model: claude-sonnet-5}
  cheap:
    - {runner: agy, model: gemini-low}
    - {runner: pi, model: test/pi-lite}
skills:
  - skills/adr
  - skills/tdd
plugins:
  - plugins/worker
mcp:
  herdr: {plugin: herdr-tools}
  executor: {plugin: herdr-executor}
runners:
  pi:
    models: [test/pi-pro, test/pi-lite]
    quota: {provider: openai, billingProduct: codex, account: primary, scope: account}
    defaults: {thinking: high, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: optional, promptDelivery: file, skillSelection: exact, toolSelection: allowlist}
    pools:
      tools: [read, bash]
      extensions: [ext/host.ts]
      skills: [skills/adr, skills/tdd]
      mcp: [herdr, executor]
  claude:
    models: [claude-opus-5, claude-sonnet-5]
    quota: {provider: anthropic, billingProduct: claude, account: primary, scope: account}
    defaults: {effort: high, permissionMode: dontAsk, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: required, promptDelivery: file, skillSelection: additive, toolSelection: allowlist}
    pools:
      tools: [Read, Bash]
      plugins: [plugins/worker]
      mcp: [herdr]
  agy:
    models: [gemini-high, gemini-low]
    quota: {provider: google, billingProduct: antigravity, account: primary, scope: account}
    defaults: {mode: plan, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: required, promptDelivery: bootstrap, skillSelection: ambient, toolSelection: ambient}
  devin:
    models: [swe-2-max]
    quota: {provider: cognition, billingProduct: devin, account: primary, scope: account}
    defaults: {permissionMode: dangerous, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: required, promptDelivery: none, skillSelection: ambient, toolSelection: ambient}
quotaSources:
  - {name: reactive-cooldowns, kind: floor}
  - {name: pi-quotas, kind: proactive, runner: pi}
`;

const MINIMAL = `version: 1
categories:
  cheap:
    - {runner: agy, model: gemini-low}
runners:
  agy:
    models: [gemini-low]
    quota: {provider: google, billingProduct: antigravity, account: primary, scope: account}
    defaults: {mode: plan, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: required, promptDelivery: bootstrap, skillSelection: ambient, toolSelection: ambient}
quotaSources:
  - {name: reactive-cooldowns, kind: floor}
`;

const PI_POOLS = "    pools:\n      tools: [read, bash]\n      extensions: [ext/host.ts]\n      skills: [skills/adr, skills/tdd]\n      mcp: [herdr, executor]\n";
const MCP_BLOCK = "mcp:\n  herdr: {plugin: herdr-tools}\n  executor: {plugin: herdr-executor}\n";
const QUOTA_BLOCK = "quotaSources:\n  - {name: reactive-cooldowns, kind: floor}\n  - {name: pi-quotas, kind: proactive, runner: pi}\n";

const parse = (text: string = VALID): Catalog => parseCatalog(text, SOURCE);

/** Force a chain shape past parse-time validation to exercise resolve-time bounds. */
function mutateChains(catalog: Catalog, name: string, chain: ChainCandidate[]): void {
  (catalog.categories as Map<string, ChainCandidate[]>).set(name, chain);
}

describe("catalog", () => {
  it("parses the shipped catalog config and resolves every declared chain", async () => {
    const catalog = await loadCatalog(join(PACKAGE_ROOT, CATALOG_PATH));
    expect(catalog.version).toBe(1);
    expect(catalog.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect([...catalog.categories.keys()].sort()).toEqual(["balanced", "cheap", "frontier"]);
    for (const [category, chain] of catalog.categories) {
      expect(chain.length).toBeGreaterThanOrEqual(1);
      expect(chain.length).toBeLessThanOrEqual(catalog.maxAttempts);
      const resolution = resolveChain(catalog, category);
      expect(resolution.selected?.candidate).toEqual(chain[0]);
      expect(resolution.remainder.map((entry) => entry.index)).toEqual(chain.map((_, index) => index).slice(1));
    }
    expect(catalog.quotaSources.some((source) => source.kind === "floor")).toBe(true);
    // Every declared resource pool path must exist inside the package root.
    for (const path of [...catalog.skills, ...catalog.plugins]) await access(path);
  });

  it("parses a full catalog: typed defaults, resolved pool paths, quota keys", () => {
    const catalog = parse();
    const pi = catalog.runners.get("pi");
    const claude = catalog.runners.get("claude");
    const agy = catalog.runners.get("agy");
    const devin = catalog.runners.get("devin");
    expect(pi?.defaults).toEqual({ thinking: "high", timeoutMinutes: 30, sessionPersistence: true });
    expect(claude?.defaults).toEqual({ effort: "high", permissionMode: "dontAsk", timeoutMinutes: 30, sessionPersistence: true });
    expect(agy?.defaults.mode).toBe("plan");
    expect(devin?.defaults.permissionMode).toBe("dangerous");
    expect(pi?.plumbing).toEqual({ sessionPersistence: "optional", promptDelivery: "file", skillSelection: "exact", toolSelection: "allowlist" });
    expect(devin?.plumbing.promptDelivery).toBe("none");
    expect(catalog.skills).toEqual([`${SCOPE}/skills/adr`, `${SCOPE}/skills/tdd`]);
    expect(pi?.pools.skills).toEqual(catalog.skills);
    expect(pi?.pools.extensions).toEqual([`${SCOPE}/ext/host.ts`]);
    expect(claude?.pools.plugins).toEqual([`${SCOPE}/plugins/worker`]);
    expect(claude?.pools.mcp).toEqual(["herdr"]);
    expect(catalog.mcpServers.get("executor")).toEqual({ plugin: "herdr-executor" });
    expect(catalog.source).toEqual(SOURCE);
    expect(quotaKeyFor({ runner: "pi", model: "test/pi-pro" }, pi!)).toEqual({ provider: "openai", billingProduct: "codex", account: "primary", scope: "account" });
    expect(quotaKeyFor({ runner: "pi", model: "test/pi-pro", account: "alt" }, pi!).account).toBe("alt");
  });

  it("defaults maxAttempts and tolerates absent pool sections", () => {
    const catalog = parse(MINIMAL);
    expect(catalog.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(catalog.skills).toEqual([]);
    expect(catalog.plugins).toEqual([]);
    expect(catalog.mcpServers.size).toBe(0);
    expect(catalog.runners.get("agy")?.pools).toEqual({ tools: [], extensions: [], skills: [], plugins: [], mcp: [] });
    expect(resolveChain(catalog, "cheap").selected?.candidate.model).toBe("gemini-low");
    // Individual pool fields are optional within a runner's pools block.
    const sparse = parse(VALID.replace("      tools: [read, bash]\n", "").replace("      mcp: [herdr, executor]\n", ""));
    expect(sparse.runners.get("pi")?.pools.tools).toEqual([]);
    expect(sparse.runners.get("pi")?.pools.mcp).toEqual([]);
  });

  it("selects the first eligible candidate and keeps the ordered remainder as fallback", () => {
    const catalog = parse();
    const availability = vi.fn((candidate: ChainCandidate) => candidate.model !== "never");
    const eligibility = vi.fn((candidate: ChainCandidate) => (candidate.runner === "devin" ? "runner not authorized for caller" : true));
    const resolution = resolveChain(catalog, "frontier", eligibility, availability);
    expect(resolution.selected).toMatchObject({ index: 1, candidate: { runner: "claude", model: "claude-opus-5" } });
    expect(resolution.selected?.runner.kind).toBe("claude");
    expect(resolution.remainder.map((entry) => entry.index)).toEqual([2, 3]);
    expect(resolution.rejected).toEqual([{ index: 0, candidate: { runner: "devin", model: "swe-2-max" }, gate: "eligibility", reason: "runner not authorized for caller" }]);
    // Eligibility failure short-circuits: the quota gate never runs for index 0.
    expect(availability.mock.calls.map(([candidate]) => candidate.model)).toEqual(["claude-opus-5", "test/pi-pro", "claude-sonnet-5"]);
  });

  it("filters by availability after eligibility and records which gate excluded each candidate", () => {
    const catalog = parse();
    const resolution = resolveChain(
      catalog,
      "frontier",
      (candidate) => (candidate.runner === "devin" ? { admissible: false } : { admissible: true }),
      (candidate) => (candidate.model === "claude-opus-5" ? { admissible: false, reason: "quota exhausted" } : true),
    );
    expect(resolution.selected?.candidate).toEqual({ runner: "pi", model: "test/pi-pro" });
    expect(resolution.remainder.map((entry) => entry.candidate.model)).toEqual(["claude-sonnet-5"]);
    expect(resolution.rejected).toEqual([
      { index: 0, candidate: { runner: "devin", model: "swe-2-max" }, gate: "eligibility" },
      { index: 1, candidate: { runner: "claude", model: "claude-opus-5" }, gate: "availability", reason: "quota exhausted" },
    ]);
  });

  it("returns no selection when every candidate is ineligible — exhaustion is a result, not an error", () => {
    const catalog = parse();
    const resolution = resolveChain(catalog, "cheap", () => false);
    expect(resolution.selected).toBeUndefined();
    expect(resolution.remainder).toEqual([]);
    expect(resolution.rejected).toHaveLength(2);
    expect(resolution.rejected.every((entry) => entry.gate === "eligibility")).toBe(true);
    expect(resolution.chain).toHaveLength(2);
  });

  it("accepts chains shorter than the bound and never truncates over-long ones", () => {
    const catalog = parse();
    expect(resolveChain(catalog, "cheap").chain).toHaveLength(2);
    expect(() => parse(VALID.replace("    - {runner: claude, model: claude-sonnet-5}\n  cheap:", "    - {runner: claude, model: claude-sonnet-5}\n    - {runner: pi, model: test/pi-lite}\n  cheap:"))).toThrow(CatalogError);
    const fat: ChainCandidate[] = [0, 1, 2, 3, 4].map((n) => ({ runner: "pi", model: `m${n}` }));
    mutateChains(catalog, "fat", fat);
    const gates = vi.fn(() => true);
    expect(() => resolveChain(catalog, "fat", gates)).toThrow(ChainResolutionError);
    expect(gates).not.toHaveBeenCalled();
    expect(catalog.categories.get("fat")).toHaveLength(5);
  });

  it("rejects duplicate chain entries; a distinct account is a distinct candidate", () => {
    // VALID's frontier chain already names claude at two models — same runner, different model is legal.
    expect(() => parse(VALID.replace("    - {runner: pi, model: test/pi-lite}\nskills:", "    - {runner: agy, model: gemini-low}\nskills:"))).toThrow(/duplicate/);
    const withAccount = VALID.replace("    - {runner: pi, model: test/pi-lite}\n", "    - {runner: pi, model: test/pi-lite}\n    - {runner: pi, model: test/pi-lite, account: secondary}\n");
    const catalog = parse(withAccount);
    expect(catalog.categories.get("cheap")).toHaveLength(3);
  });

  it("rejects unknown runners and models", () => {
    expect(() => parse(VALID.replace("{runner: devin, model: swe-2-max}", "{runner: nomad, model: swe-2-max}"))).toThrow(/does not declare/);
    expect(() => parse(VALID.replace("{runner: devin, model: swe-2-max}", "{runner: devin, model: bogus}"))).toThrow(/reviewed devin model set/);
    expect(() => parse(VALID.replace("  devin:", "  nomad:"))).toThrow(/runners.nomad/);
  });

  it("rejects malformed YAML, YAML features, and invalid shapes", () => {
    const cases = [
      "",
      "version: [",
      "---\n- a\n- b\n",
      "? just-a-key\n",
      VALID.replace("version: 1", "version: 2"),
      VALID.replace("version: 1\n", ""),
      VALID.replace("version: 1", "version: one"),
      VALID.replace("maxAttempts: 4", "maxAttempts: 0"),
      VALID.replace("maxAttempts: 4", "maxAttempts: 2.5"),
      VALID.replace("version: 1", "version: 1\nbogus: []"),
      VALID.replace("categories:", "category sets:"),
      VALID.replace("  frontier:", "  Frontier:"),
      VALID.replace("  cheap:\n    - {runner: agy, model: gemini-low}\n    - {runner: pi, model: test/pi-lite}\n", "  cheap: []\n"),
      VALID.replace("categories:\n", "categories: {}\n").replace(/ {2}frontier:[\s\S]*? {2}cheap:[\s\S]*?\nskills:/, "skills:"),
      VALID.replace("categories:\n", "categories: 5\n"),
      VALID.replace("  cheap:\n    - {runner: agy, model: gemini-low}\n    - {runner: pi, model: test/pi-lite}\n", "  cheap: 5\n"),
      VALID.replace("    - {runner: devin, model: swe-2-max}", "    - devin"),
      VALID.replace("    - {runner: devin, model: swe-2-max}", "    - {runner: devin, model: swe-2-max, extra: 1}"),
      VALID.replace("    - {runner: devin, model: swe-2-max}", "    - {runner: devin}"),
      VALID.replace("    - {runner: devin, model: swe-2-max}", "    - {runner: 5, model: swe-2-max}"),
      VALID.replace("    - {runner: devin, model: swe-2-max}", "    - {runner: devin, model: swe-2-max, account: 5}"),
      VALID.replace("runners:\n", "runners: {}\n").replace(/ {2}pi:[\s\S]*?quotaSources:/, "quotaSources:"),
      VALID.replace("runners:\n", "runners: 5\n"),
      VALID.replace(/ {2}pi:[\s\S]*? {2}claude:/, "  pi: 5\n  claude:"),
      VALID.replace("  pi:\n    models:", "  pi:\n    stray: 1\n    models:"),
      VALID.replace("    quota: {provider: openai, billingProduct: codex, account: primary, scope: account}", "    quota: 5"),
      VALID.replace("    defaults: {thinking: high, timeoutMinutes: 30, sessionPersistence: true}", "    defaults: 5"),
      VALID.replace("    plumbing: {sessionPersistence: optional, promptDelivery: file, skillSelection: exact, toolSelection: allowlist}", "    plumbing: 5"),
      VALID.replace("    models: [test/pi-pro, test/pi-lite]", "    models: []"),
      VALID.replace("    models: [test/pi-pro, test/pi-lite]", "    models: [test/pi-pro, test/pi-pro]"),
      VALID.replace("    models: [test/pi-pro, test/pi-lite]", "    models: 5"),
      VALID.replace("    quota: {provider: openai", "    quota: {provider: openai, tenant: x"),
      VALID.replace("quota: {provider: openai, billingProduct: codex, account: primary, scope: account}", "quota: {provider: openai, billingProduct: codex, account: primary}"),
      VALID.replace("defaults: {thinking: high", "defaults: {thinking: bogus"),
      VALID.replace("defaults: {effort: high", "defaults: {effort: bogus"),
      VALID.replace("permissionMode: dontAsk", "permissionMode: bogus"),
      VALID.replace("mode: plan", "mode: bogus"),
      VALID.replace("permissionMode: dangerous", "permissionMode: bogus"),
      VALID.replace("timeoutMinutes: 30, sessionPersistence: true}\n    plumbing: {sessionPersistence: optional", "timeoutMinutes: 0, sessionPersistence: true}\n    plumbing: {sessionPersistence: optional"),
      VALID.replace("timeoutMinutes: 30, sessionPersistence: true}\n    plumbing: {sessionPersistence: optional", "timeoutMinutes: 61, sessionPersistence: true}\n    plumbing: {sessionPersistence: optional"),
      VALID.replace("defaults: {thinking: high", "defaults: {thinking: high, extra: 1"),
      VALID.replace("defaults: {thinking: high, timeoutMinutes: 30, sessionPersistence: true}", "defaults: {thinking: high, timeoutMinutes: 30, sessionPersistence: nope}"),
      VALID.replace("defaults: {effort: high, permissionMode: dontAsk, timeoutMinutes: 30, sessionPersistence: true}", "defaults: {effort: high, permissionMode: dontAsk, timeoutMinutes: 30, sessionPersistence: false}"),
      VALID.replace("defaults: {mode: plan, timeoutMinutes: 30, sessionPersistence: true}", "defaults: {mode: plan, timeoutMinutes: 30, sessionPersistence: false}"),
      VALID.replace("defaults: {permissionMode: dangerous, timeoutMinutes: 30, sessionPersistence: true}", "defaults: {permissionMode: dangerous, timeoutMinutes: 30, sessionPersistence: false}"),
      VALID.replace("plumbing: {sessionPersistence: optional", "plumbing: {sessionPersistence: required"),
      VALID.replace("plumbing: {sessionPersistence: required, promptDelivery: file", "plumbing: {sessionPersistence: required, promptDelivery: none"),
      VALID.replace("plumbing: {sessionPersistence: required, promptDelivery: none", "plumbing: {sessionPersistence: required, promptDelivery: file"),
      VALID.replace("skillSelection: ambient, toolSelection: ambient}\n  devin:", "skillSelection: exact, toolSelection: ambient}\n  devin:"),
      VALID.replace("plumbing: {sessionPersistence: optional, promptDelivery: file, skillSelection: exact, toolSelection: allowlist}", "plumbing: {sessionPersistence: optional, promptDelivery: file, skillSelection: exact}"),
      VALID.replace("plumbing: {sessionPersistence: optional, promptDelivery: file", "plumbing: {sessionPersistence: optional, promptDelivery: file, x: 1"),
      VALID.replace(PI_POOLS, "    pools: 5\n"),
      VALID.replace(PI_POOLS, ""),
      VALID.replace("      skills: [skills/adr, skills/tdd]", "      skills: [skills/nope]"),
      VALID.replace("      skills: [skills/adr, skills/tdd]", "      plugins: [plugins/worker]"),
      VALID.replace("      plugins: [plugins/worker]", "      plugins: [plugins/missing]"),
      VALID.replace("      mcp: [herdr, executor]", "      mcp: [unknown-server]"),
      VALID.replace("    defaults: {thinking: high, timeoutMinutes: 30, sessionPersistence: true}", "    defaults:"),
      VALID.replace("      tools: [read, bash]", "      tools: [read, read]"),
      VALID.replace("      extensions: [ext/host.ts]", "      extensions: [../escape.ts]"),
      VALID.replace("      extensions: [ext/host.ts]", "      extensions: 5"),
      VALID.replace("  agy:\n    models:", "  agy:\n    pools: {tools: []}\n    models:"),
      VALID.replace("skills:\n  - skills/adr", "skills:\n  - ../outside"),
      VALID.replace("skills:\n", "skills: 5\n"),
      VALID.replace("skills:\n  - skills/adr", "skills:\n  - skills/adr\n  - skills/adr"),
      VALID.replace("mcp:\n  herdr: {plugin: herdr-tools}", "mcp:\n  Herdr: {plugin: herdr-tools}"),
      VALID.replace("mcp:\n  herdr: {plugin: herdr-tools}", "mcp:\n  herdr: {plugin: herdr-tools, port: 1}"),
      VALID.replace("mcp:\n  herdr: {plugin: herdr-tools}", "mcp:\n  herdr: 5"),
      VALID.replace(MCP_BLOCK, "mcp: 5\n"),
      VALID.replace(QUOTA_BLOCK, "quotaSources: {}\n"),
      VALID.replace("  - {name: reactive-cooldowns, kind: floor}\n", ""),
      VALID.replace("  - {name: pi-quotas, kind: proactive, runner: pi}", "  - {name: other-floor, kind: floor}"),
      VALID.replace("  - {name: pi-quotas, kind: proactive, runner: pi}", "  - {name: pi-quotas, kind: proactive, runner: pi}\n  - {name: pi-quotas, kind: proactive, runner: pi}"),
      VALID.replace("kind: proactive, runner: pi}", "kind: proactive, runner: nomad}"),
      VALID.replace("kind: proactive, runner: pi}", "kind: proactive}"),
      VALID.replace("kind: proactive, runner: pi}", "kind: coarse}"),
      VALID.replace("kind: proactive, runner: pi}", "kind: bogus, runner: pi}"),
      VALID.replace("kind: floor}", "kind: floor, runner: pi}"),
      VALID.replace("  - {name: reactive-cooldowns, kind: floor}", "  - 5"),
      VALID.replace("  - {name: reactive-cooldowns, kind: floor}", "  - {name: reactive-cooldowns, kind: floor, zone: x}"),
      // Anchors, aliases, and tags are refused outright.
      VALID.replace("version: 1", "version: 1\nanchored: &a x\naliased: *a"),
      VALID.replace("version: 1", "version: &v 1"),
      VALID.replace("version: 1", "version: !!str 1"),
    ];
    for (const [index, text] of cases.entries()) expect(() => parse(text), `case ${index}`).toThrow(CatalogError);
  });

  it("fails closed on unresolvable categories", () => {
    const catalog = parse();
    for (const category of ["missing", "Frontier", ""]) expect(() => resolveChain(catalog, category)).toThrow(ChainResolutionError);
    mutateChains(catalog, "empty", []);
    expect(() => resolveChain(catalog, "empty")).toThrow(ChainResolutionError);
    mutateChains(catalog, "dangling", [{ runner: "nope" as never, model: "gone" }]);
    expect(() => resolveChain(catalog, "dangling")).toThrow(/undeclared runner/);
  });

  it("is pure: only loadCatalog performs I/O, and resolution is deterministic", async () => {
    const readFile = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("I/O is forbidden in resolution"));
    try {
      const catalog = parseCatalog(VALID, SOURCE);
      const first = resolveChain(catalog, "frontier", (candidate) => candidate.runner !== "devin");
      const second = resolveChain(catalog, "frontier", (candidate) => candidate.runner !== "devin");
      expect(first).toEqual(second);
      expect(first).not.toBeInstanceOf(Promise);
      expect(readFile).not.toHaveBeenCalled();
      await expect(loadCatalog(join(PACKAGE_ROOT, CATALOG_PATH))).rejects.toThrow("I/O is forbidden");
      expect(readFile).toHaveBeenCalledTimes(1);
    } finally {
      readFile.mockRestore();
    }
  });

  it("loads through the injected I/O boundary and enforces the size cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-catalog-"));
    const dir = join(root, dirname(CATALOG_PATH));
    await mkdir(dir, { recursive: true });
    const path = join(dir, "catalog.yaml");
    await writeFile(path, MINIMAL);
    // The default scope root is the parent of the catalog's directory.
    const loaded = await loadCatalog(path);
    expect(loaded.source.scopeRoot).toBe(resolve(root));
    const io = { readFile: async (p: string) => { expect(p).toBe(resolve(path)); return VALID; } };
    expect((await loadCatalog(path, SCOPE, io)).runners.size).toBe(4);
    expect(() => parse(`${" ".repeat(65 * 1024)}`)).toThrow(/64 KiB/);
    await expect(loadCatalog(join(root, "missing.yaml"))).rejects.toThrow();
  });
});
