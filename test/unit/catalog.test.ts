import { promises as fs } from "node:fs";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CATALOG_PATH, CatalogError, catalogRevisionOf, loadCatalog, parseCatalog, pointsWithinTier, quotaKeyFor, type Catalog, type OperatingPoint } from "../../src/catalog.js";
import { CLAUDE_EFFORTS, THINKING_LEVELS } from "../../src/profiles/types.js";
import type { QualityTier } from "../../src/routing-policy.js";

const SCOPE = "/catalog-scope";
const SOURCE = { path: `${SCOPE}/herdr-profiles/catalog.yaml`, scopeRoot: SCOPE };
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** VALID's structured pi model entries: two codex models on the six-setting axis plus one zai-domain model. */
const PI_MODELS = `    models:
      - {model: openai/pi-pro, supportedReasoning: [off, low, medium, high, xhigh, max]}
      - {model: openai/pi-lite, supportedReasoning: [off, low, medium, high, xhigh, max]}
      - {model: zai/test-glm, provider: zai, quota: {billingProduct: zai-api}, supportedReasoning: [low, high, max]}`;

/** Every point VALID generates — each model entry crossed with its declared reasoning set — each with a uniform low/low policy. */
const POINT_POLICY = `pointPolicy:\n${[
  ...["openai/pi-pro", "openai/pi-lite"].flatMap((model) => ["off", "low", "medium", "high", "xhigh", "max"].map((level) => `  pi:${model}:${level}: {costClass: low, latencyClass: low}`)),
  ...["low", "high", "max"].map((level) => `  pi:zai/test-glm:${level}: {costClass: low, latencyClass: low}`),
  ...["claude-opus-5", "claude-sonnet-5"].flatMap((model) => CLAUDE_EFFORTS.map((effort) => `  claude:${model}:${effort}: {costClass: low, latencyClass: low}`)),
  "  agy:gemini-high: {costClass: low, latencyClass: low}",
  "  agy:gemini-low: {costClass: low, latencyClass: low}",
  "  devin:swe-2-max: {costClass: low, latencyClass: low}",
].join("\n")}\n`;

const VALID = `version: 2
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
${PI_MODELS}
    quota: {provider: openai, billingProduct: codex, account: primary, scope: account}
    defaults: {thinking: high, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: optional, promptDelivery: file, skillSelection: exact, toolSelection: allowlist}
    pools:
      tools: [read, bash]
      extensions: [ext/host.ts]
      skills: [skills/adr, skills/tdd]
      mcp: [herdr, executor]
  claude:
    models: [{model: claude-opus-5, supportedReasoning: [low, medium, high, max]}, {model: claude-sonnet-5, supportedReasoning: [low, medium, high, max]}]
    quota: {provider: anthropic, billingProduct: claude, account: primary, scope: account}
    defaults: {effort: high, permissionMode: dontAsk, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: required, promptDelivery: file, skillSelection: additive, toolSelection: allowlist}
    pools:
      tools: [Read, Bash]
      plugins: [plugins/worker]
      mcp: [herdr]
  agy:
    models: [{model: gemini-high}, {model: gemini-low}]
    quota: {provider: google, billingProduct: antigravity, account: primary, scope: account}
    defaults: {mode: plan, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: required, promptDelivery: bootstrap, skillSelection: ambient, toolSelection: ambient}
  devin:
    models: [{model: swe-2-max}]
    quota: {provider: cognition, billingProduct: devin, account: primary, scope: account}
    defaults: {permissionMode: dangerous, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: required, promptDelivery: none, skillSelection: ambient, toolSelection: ambient}
${POINT_POLICY}quotaSources:
  - {name: reactive-cooldowns, kind: floor}
  - {name: pi-quotas, kind: proactive, runner: pi}
`;

const MINIMAL = `version: 2
runners:
  agy:
    models: [{model: gemini-low}]
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

describe("catalog", () => {
  it("parses the shipped catalog config and its generated point set", async () => {
    const catalog = await loadCatalog(join(PACKAGE_ROOT, CATALOG_PATH));
    expect(catalog.version).toBe(2);
    expect(catalog.points).toHaveLength(54);
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
    expect(pi?.models.map((entry) => entry.model)).toEqual(["openai/pi-pro", "openai/pi-lite", "zai/test-glm"]);
    expect(pi?.models[2]).toEqual({ model: "zai/test-glm", provider: "zai", quota: { billingProduct: "zai-api" }, supportedReasoning: ["low", "high", "max"] });
    expect(quotaKeyFor({ runner: "pi", model: "openai/pi-pro" }, pi!)).toEqual({ provider: "openai", billingProduct: "codex", account: "primary", scope: "account" });
    // Model-level attribution: the zai entry keeps its own quota domain.
    expect(quotaKeyFor({ runner: "pi", model: "zai/test-glm" }, pi!)).toEqual({ provider: "zai", billingProduct: "zai-api", account: "primary", scope: "account" });
    // A model entry may override the account alone inside its declared domain.
    const modelAccount = parse(VALID.replace("quota: {billingProduct: zai-api}", "quota: {billingProduct: zai-api, account: zai-alt}"));
    expect(quotaKeyFor({ runner: "pi", model: "zai/test-glm" }, modelAccount.runners.get("pi")!)).toEqual({ provider: "zai", billingProduct: "zai-api", account: "zai-alt", scope: "account" });
    // An account-only model override keeps the runner's billing product.
    const accountOnly = parse(VALID.replace("quota: {billingProduct: zai-api}", "quota: {account: zai-alt}"));
    expect(quotaKeyFor({ runner: "pi", model: "zai/test-glm" }, accountOnly.runners.get("pi")!)).toEqual({ provider: "zai", billingProduct: "codex", account: "zai-alt", scope: "account" });
  });

  it("tolerates absent pool sections", () => {
    const catalog = parse(MINIMAL);
    expect(catalog.skills).toEqual([]);
    expect(catalog.plugins).toEqual([]);
    expect(catalog.mcpServers.size).toBe(0);
    expect(catalog.runners.get("agy")?.pools).toEqual({ tools: [], extensions: [], skills: [], plugins: [], mcp: [] });
    // Individual pool fields are optional within a runner's pools block.
    const sparse = parse(VALID.replace("      tools: [read, bash]\n", "").replace("      mcp: [herdr, executor]\n", ""));
    expect(sparse.runners.get("pi")?.pools.tools).toEqual([]);
    expect(sparse.runners.get("pi")?.pools.mcp).toEqual([]);
  });

  it("rejects undeclared runner names", () => {
    expect(() => parse(VALID.replace("  devin:", "  nomad:"))).toThrow(/runners.nomad/);
  });

  it("rejects malformed YAML, YAML features, and invalid shapes", () => {
    const cases = [
      "",
      "version: [",
      "---\n- a\n- b\n",
      "? just-a-key\n",
      VALID.replace("version: 2", "version: 1"),
      VALID.replace("version: 2\n", ""),
      VALID.replace("version: 2", "version: one"),
      // The retired top-level bound is refused like any other unknown field —
      // the attempt bound is a routing-policy constant, not catalog data.
      VALID.replace("version: 2", "version: 2\nmaxAttempts: 4"),
      VALID.replace("version: 2", "version: 2\nbogus: []"),
      // The retired top-level key is refused like any other unknown field.
      VALID.replace("version: 2", "version: 2\ncategories: {}"),
      VALID.replace("runners:\n", "runners: {}\n").replace(/ {2}pi:[\s\S]*?quotaSources:/, "quotaSources:"),
      VALID.replace("runners:\n", "runners: 5\n"),
      VALID.replace(/ {2}pi:[\s\S]*? {2}claude:/, "  pi: 5\n  claude:"),
      VALID.replace("  pi:\n    models:", "  pi:\n    stray: 1\n    models:"),
      VALID.replace("    quota: {provider: openai, billingProduct: codex, account: primary, scope: account}", "    quota: 5"),
      VALID.replace("    defaults: {thinking: high, timeoutMinutes: 30, sessionPersistence: true}", "    defaults: 5"),
      VALID.replace("    plumbing: {sessionPersistence: optional, promptDelivery: file, skillSelection: exact, toolSelection: allowlist}", "    plumbing: 5"),
      VALID.replace(PI_MODELS, "    models: []"),
      VALID.replace(PI_MODELS, "    models: [{model: openai/pi-pro}, {model: openai/pi-pro}]"),
      VALID.replace(PI_MODELS, "    models: 5"),
      // Model entries are structured: a bare string, an unknown field, a
      // billing-product override with no provider namespace, a foreign-prefix
      // id with no provider, and off-axis or runner-alias reasoning all fail.
      VALID.replace(PI_MODELS, "    models: [openai/pi-pro]"),
      VALID.replace("- {model: openai/pi-lite", "- {bogus: 1, model: openai/pi-lite"),
      VALID.replace("- {model: zai/test-glm, provider: zai, quota: {billingProduct: zai-api}", "- {model: zai/test-glm, quota: {billingProduct: zai-api}"),
      VALID.replace("quota: {billingProduct: zai-api}", "quota: 5"),
      VALID.replace("- {model: zai/test-glm, provider: zai, quota: {billingProduct: zai-api},", "- {model: zai/test-glm,"),
      VALID.replace("supportedReasoning: [off, low, medium, high, xhigh, max]}", "supportedReasoning: 5}"),
      VALID.replace("supportedReasoning: [off, low, medium, high, xhigh, max]}", "supportedReasoning: [off, off]}"),
      VALID.replace("supportedReasoning: [off, low, medium, high, xhigh, max]}", "supportedReasoning: [minimal]}"),
      VALID.replace("supportedReasoning: [off, low, medium, high, xhigh, max]}", "supportedReasoning: [bogus]}"),
      VALID.replace("{model: claude-opus-5, supportedReasoning: [low, medium, high, max]}", "{model: claude-opus-5, supportedReasoning: [low, off]}"),
      VALID.replace("models: [{model: gemini-high}, {model: gemini-low}]", "models: [{model: gemini-high, supportedReasoning: [low]}, {model: gemini-low}]"),
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
      VALID.replace("version: 2", "version: 2\nanchored: &a x\naliased: *a"),
      VALID.replace("version: 2", "version: &v 2"),
      VALID.replace("version: 2", "version: !!str 2"),
    ];
    for (const [index, text] of cases.entries()) expect(() => parse(text), `case ${index}`).toThrow(CatalogError);
  });

  it("is pure: only loadCatalog performs I/O, and tier filtering is deterministic", async () => {
    const readFile = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("I/O is forbidden in resolution"));
    try {
      const catalog = parseCatalog(VALID, SOURCE);
      const first = pointsWithinTier(catalog.points ?? [], "standard").map((point) => point.id);
      const second = pointsWithinTier(catalog.points ?? [], "standard").map((point) => point.id);
      expect(first).toEqual(second);
      expect(first.length).toBeGreaterThan(0);
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
    expect(loaded.catalogRevision).toBe(catalogRevisionOf(MINIMAL));
    const io = { readFile: async (p: string) => { expect(p).toBe(resolve(path)); return VALID; } };
    expect((await loadCatalog(path, SCOPE, io)).runners.size).toBe(4);
    expect((await loadCatalog(path, SCOPE, io)).catalogRevision).toBe(catalogRevisionOf(VALID));
    expect(() => parse(`${" ".repeat(65 * 1024)}`)).toThrow(/64 KiB/);
    await expect(loadCatalog(join(root, "missing.yaml"))).rejects.toThrow();
  });

  it("ships exactly the audited 54 operating points with the frozen policy table", async () => {
    const catalog = await loadCatalog(join(PACKAGE_ROOT, CATALOG_PATH));
    const points = catalog.points ?? [];
    expect(points).toHaveLength(54);
    expect(catalog.pointPolicy?.size).toBe(54);
    for (const point of points) expect(catalog.pointPolicy?.get(point.id)).toEqual({ costClass: point.costClass, latencyClass: point.latencyClass });
    // The FROZEN Appendix A table (plan-delta-model-audit v3.1), verbatim —
    // every declared class is compared, key for key.
    expect(Object.fromEntries(catalog.pointPolicy ?? new Map())).toEqual({
      "pi:openai-codex/gpt-5.6-luna:off": { costClass: "low", latencyClass: "low" },
      "pi:openai-codex/gpt-5.6-luna:low": { costClass: "low", latencyClass: "low" },
      "pi:openai-codex/gpt-5.6-luna:medium": { costClass: "low", latencyClass: "low" },
      "pi:openai-codex/gpt-5.6-luna:high": { costClass: "low", latencyClass: "medium" },
      "pi:openai-codex/gpt-5.6-luna:xhigh": { costClass: "low", latencyClass: "medium" },
      "pi:openai-codex/gpt-5.6-luna:max": { costClass: "low", latencyClass: "medium" },
      "pi:openai-codex/gpt-5.6-terra:off": { costClass: "medium", latencyClass: "low" },
      "pi:openai-codex/gpt-5.6-terra:low": { costClass: "medium", latencyClass: "low" },
      "pi:openai-codex/gpt-5.6-terra:medium": { costClass: "medium", latencyClass: "low" },
      "pi:openai-codex/gpt-5.6-terra:high": { costClass: "medium", latencyClass: "medium" },
      "pi:openai-codex/gpt-5.6-terra:xhigh": { costClass: "medium", latencyClass: "medium" },
      "pi:openai-codex/gpt-5.6-terra:max": { costClass: "medium", latencyClass: "medium" },
      "pi:openai-codex/gpt-5.6-sol:off": { costClass: "high", latencyClass: "medium" },
      "pi:openai-codex/gpt-5.6-sol:low": { costClass: "high", latencyClass: "medium" },
      "pi:openai-codex/gpt-5.6-sol:medium": { costClass: "high", latencyClass: "medium" },
      "pi:openai-codex/gpt-5.6-sol:high": { costClass: "high", latencyClass: "high" },
      "pi:openai-codex/gpt-5.6-sol:xhigh": { costClass: "high", latencyClass: "high" },
      "pi:openai-codex/gpt-5.6-sol:max": { costClass: "high", latencyClass: "high" },
      "pi:openai-codex/gpt-6-astra:low": { costClass: "extreme", latencyClass: "high" },
      "pi:openai-codex/gpt-6-astra:medium": { costClass: "extreme", latencyClass: "high" },
      "pi:openai-codex/gpt-6-astra:high": { costClass: "extreme", latencyClass: "extreme" },
      "pi:openai-codex/gpt-6-astra:xhigh": { costClass: "extreme", latencyClass: "extreme" },
      "pi:openai-codex/gpt-6-astra:max": { costClass: "extreme", latencyClass: "extreme" },
      "claude:fable:low": { costClass: "extreme", latencyClass: "high" },
      "claude:fable:medium": { costClass: "extreme", latencyClass: "high" },
      "claude:fable:high": { costClass: "extreme", latencyClass: "extreme" },
      "claude:fable:max": { costClass: "extreme", latencyClass: "extreme" },
      "claude:opus:low": { costClass: "high", latencyClass: "medium" },
      "claude:opus:medium": { costClass: "high", latencyClass: "medium" },
      "claude:opus:high": { costClass: "high", latencyClass: "high" },
      "claude:opus:max": { costClass: "high", latencyClass: "high" },
      "claude:sonnet:low": { costClass: "medium", latencyClass: "low" },
      "claude:sonnet:medium": { costClass: "medium", latencyClass: "low" },
      "claude:sonnet:high": { costClass: "medium", latencyClass: "medium" },
      "claude:sonnet:max": { costClass: "medium", latencyClass: "medium" },
      "claude:haiku": { costClass: "medium", latencyClass: "low" },
      "agy:gemini-3.8-flash-low": { costClass: "medium", latencyClass: "medium" },
      "agy:gemini-3.8-flash-medium": { costClass: "medium", latencyClass: "medium" },
      "agy:gemini-3.8-flash-high": { costClass: "medium", latencyClass: "high" },
      "pi:zai/glm-5.3-flash:low": { costClass: "low", latencyClass: "medium" },
      "pi:zai/glm-5.3-flash:high": { costClass: "low", latencyClass: "high" },
      "pi:zai/glm-5.3-flash:max": { costClass: "low", latencyClass: "high" },
      "pi:opencode-go/glm-5.3-flash:low": { costClass: "low", latencyClass: "high" },
      "pi:opencode-go/glm-5.3-flash:high": { costClass: "low", latencyClass: "high" },
      "pi:opencode-go/glm-5.3-flash:max": { costClass: "low", latencyClass: "high" },
      "devin:swe-2-medium": { costClass: "medium", latencyClass: "medium" },
      "devin:swe-2-high": { costClass: "medium", latencyClass: "high" },
      "devin:swe-2-max": { costClass: "medium", latencyClass: "high" },
      "devin:swe-1-7-lightning-medium": { costClass: "medium", latencyClass: "low" },
      "devin:swe-1-7-lightning": { costClass: "medium", latencyClass: "low" },
      "devin:fusion-claude-fable-5-1-medium-sidekick-swe-2-medium": { costClass: "extreme", latencyClass: "high" },
      "devin:fusion-claude-fable-5-1-high-sidekick-swe-2-medium": { costClass: "extreme", latencyClass: "extreme" },
      "devin:fusion-gpt-6-astra-medium-sidekick-swe-2-medium": { costClass: "extreme", latencyClass: "high" },
      "devin:fusion-gpt-6-astra-high-sidekick-swe-2-medium": { costClass: "extreme", latencyClass: "extreme" },
    });
    expect(points.filter((point) => point.runner === "pi")).toHaveLength(29);
    expect(points.filter((point) => point.runner === "claude")).toHaveLength(13);
    expect(points.filter((point) => point.runner === "agy")).toHaveLength(3);
    expect(points.filter((point) => point.runner === "devin")).toHaveLength(9);
    // Pi `minimal` never mints a canonical point; the adaptive router model is absent.
    expect(points.some((point) => point.reasoning === "minimal" || point.id.endsWith(":minimal"))).toBe(false);
    expect(points.some((point) => point.model === "adaptive")).toBe(false);
    // Below-runner attribution: the zai and opencode-go points carry their own
    // quota domain, never the runner's codex tuple.
    expect(points.find((point) => point.id === "pi:zai/glm-5.3-flash:low")).toMatchObject({ provider: "zai", quota: { provider: "zai", billingProduct: "zai-api", account: "primary", scope: "account" } });
    expect(points.find((point) => point.id === "pi:opencode-go/glm-5.3-flash:low")).toMatchObject({ provider: "opencode-go", quota: { billingProduct: "opencode-go-subscription" } });
    expect(catalog.catalogRevision).toMatch(/^[0-9a-f]{64}$/);
    // Per-tier exact eligible-id sets, derived from the frozen table.
    const ids = (tier: QualityTier) => pointsWithinTier(points, tier).map((point) => point.id).sort();
    expect(ids("utility")).toEqual([
      "pi:openai-codex/gpt-5.6-luna:low",
      "pi:openai-codex/gpt-5.6-luna:medium",
      "pi:openai-codex/gpt-5.6-luna:off",
    ]);
    expect(ids("economy")).toEqual([
      "pi:openai-codex/gpt-5.6-luna:high",
      "pi:openai-codex/gpt-5.6-luna:low",
      "pi:openai-codex/gpt-5.6-luna:max",
      "pi:openai-codex/gpt-5.6-luna:medium",
      "pi:openai-codex/gpt-5.6-luna:off",
      "pi:openai-codex/gpt-5.6-luna:xhigh",
      "pi:zai/glm-5.3-flash:low",
    ]);
    expect(ids("standard")).toEqual([
      "agy:gemini-3.8-flash-low",
      "agy:gemini-3.8-flash-medium",
      "claude:haiku",
      "claude:sonnet:high",
      "claude:sonnet:low",
      "claude:sonnet:max",
      "claude:sonnet:medium",
      "devin:swe-1-7-lightning",
      "devin:swe-1-7-lightning-medium",
      "devin:swe-2-medium",
      "pi:openai-codex/gpt-5.6-luna:high",
      "pi:openai-codex/gpt-5.6-luna:low",
      "pi:openai-codex/gpt-5.6-luna:max",
      "pi:openai-codex/gpt-5.6-luna:medium",
      "pi:openai-codex/gpt-5.6-luna:off",
      "pi:openai-codex/gpt-5.6-luna:xhigh",
      "pi:openai-codex/gpt-5.6-terra:high",
      "pi:openai-codex/gpt-5.6-terra:low",
      "pi:openai-codex/gpt-5.6-terra:max",
      "pi:openai-codex/gpt-5.6-terra:medium",
      "pi:openai-codex/gpt-5.6-terra:off",
      "pi:openai-codex/gpt-5.6-terra:xhigh",
      "pi:zai/glm-5.3-flash:low",
    ]);
    expect(ids("strong")).toEqual([
      "agy:gemini-3.8-flash-high",
      "agy:gemini-3.8-flash-low",
      "agy:gemini-3.8-flash-medium",
      "claude:haiku",
      "claude:opus:high",
      "claude:opus:low",
      "claude:opus:max",
      "claude:opus:medium",
      "claude:sonnet:high",
      "claude:sonnet:low",
      "claude:sonnet:max",
      "claude:sonnet:medium",
      "devin:swe-1-7-lightning",
      "devin:swe-1-7-lightning-medium",
      "devin:swe-2-high",
      "devin:swe-2-max",
      "devin:swe-2-medium",
      "pi:openai-codex/gpt-5.6-luna:high",
      "pi:openai-codex/gpt-5.6-luna:low",
      "pi:openai-codex/gpt-5.6-luna:max",
      "pi:openai-codex/gpt-5.6-luna:medium",
      "pi:openai-codex/gpt-5.6-luna:off",
      "pi:openai-codex/gpt-5.6-luna:xhigh",
      "pi:openai-codex/gpt-5.6-sol:high",
      "pi:openai-codex/gpt-5.6-sol:low",
      "pi:openai-codex/gpt-5.6-sol:max",
      "pi:openai-codex/gpt-5.6-sol:medium",
      "pi:openai-codex/gpt-5.6-sol:off",
      "pi:openai-codex/gpt-5.6-sol:xhigh",
      "pi:openai-codex/gpt-5.6-terra:high",
      "pi:openai-codex/gpt-5.6-terra:low",
      "pi:openai-codex/gpt-5.6-terra:max",
      "pi:openai-codex/gpt-5.6-terra:medium",
      "pi:openai-codex/gpt-5.6-terra:off",
      "pi:openai-codex/gpt-5.6-terra:xhigh",
      "pi:opencode-go/glm-5.3-flash:high",
      "pi:opencode-go/glm-5.3-flash:low",
      "pi:opencode-go/glm-5.3-flash:max",
      "pi:zai/glm-5.3-flash:high",
      "pi:zai/glm-5.3-flash:low",
      "pi:zai/glm-5.3-flash:max",
    ]);
    // frontier's envelope (extreme/extreme) and max's unbounded envelope both
    // admit the whole reviewed set.
    const all = points.map((point) => point.id).sort();
    expect(ids("frontier")).toEqual(all);
    expect(ids("max")).toEqual(all);
  });

  it("generates model x declared-reasoning points with opaque ids and merged quota attribution", () => {
    const catalog = parse();
    const points = catalog.points ?? [];
    expect(points).toHaveLength(26);
    const ids = points.map((point) => point.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const model of ["openai/pi-pro", "openai/pi-lite"]) for (const level of ["off", "low", "medium", "high", "xhigh", "max"]) expect(ids).toContain(`pi:${model}:${level}`);
    for (const level of ["low", "high", "max"]) expect(ids).toContain(`pi:zai/test-glm:${level}`);
    // The runner-level `minimal` alias never mints a canonical point.
    expect(ids.some((id) => id.endsWith(":minimal"))).toBe(false);
    for (const model of ["claude-opus-5", "claude-sonnet-5"]) for (const effort of CLAUDE_EFFORTS) expect(ids).toContain(`claude:${model}:${effort}`);
    // Model-encoded runners emit one bare `runner:model` point — no reasoning segment or field.
    expect(ids).toEqual(expect.arrayContaining(["agy:gemini-high", "agy:gemini-low", "devin:swe-2-max"]));
    for (const point of points) {
      if (point.runner === "pi") expect(THINKING_LEVELS.filter((level) => level !== "minimal")).toContain(point.reasoning);
      if (point.runner === "claude") expect(CLAUDE_EFFORTS).toContain(point.reasoning);
      if (point.runner === "agy" || point.runner === "devin") expect("reasoning" in point).toBe(false);
    }
    expect(points.find((point) => point.id === "pi:openai/pi-pro:high")).toMatchObject({ runner: "pi", model: "openai/pi-pro", reasoning: "high", provider: "openai", quota: { provider: "openai", billingProduct: "codex", account: "primary", scope: "account" }, costClass: "low", latencyClass: "low" });
    expect(points.find((point) => point.id === "pi:zai/test-glm:high")).toMatchObject({ provider: "zai", quota: { provider: "zai", billingProduct: "zai-api", account: "primary", scope: "account" } });
    expect(catalog.pointPolicy?.get("devin:swe-2-max")).toEqual({ costClass: "low", latencyClass: "low" });
  });

  it("requires a declared pointPolicy to match the generated point set exactly", () => {
    const missing = VALID.replace("  devin:swe-2-max: {costClass: low, latencyClass: low}\n", "");
    const unknown = VALID.replace("  devin:swe-2-max:", "  devin:bogus: {costClass: low, latencyClass: low}\n  devin:swe-2-max:");
    const duplicate = VALID.replace("  devin:swe-2-max: {costClass: low, latencyClass: low}\n", "  devin:swe-2-max: {costClass: low, latencyClass: low}\n  devin:swe-2-max: {costClass: medium, latencyClass: medium}\n");
    const cases = [
      missing,
      unknown,
      duplicate,
      VALID.replace(POINT_POLICY, "pointPolicy: []\n"),
      VALID.replace("  devin:swe-2-max: {costClass: low, latencyClass: low}\n", "  devin:swe-2-max: 5\n"),
      VALID.replace("  devin:swe-2-max: {costClass: low, latencyClass: low}", "  devin:swe-2-max: {costClass: low, latencyClass: low, region: x}"),
      VALID.replace("  devin:swe-2-max: {costClass: low, latencyClass: low}", "  devin:swe-2-max: {costClass: low}"),
      VALID.replace("  devin:swe-2-max: {costClass: low, latencyClass: low}", "  devin:swe-2-max: {costClass: low, latencyClass: bogus}"),
    ];
    for (const [index, text] of cases.entries()) expect(() => parse(text), `case ${index}`).toThrow(CatalogError);
    expect(() => parse(missing)).toThrow(/every generated operating point/);
    expect(() => parse(unknown)).toThrow(/does not generate/);
    try {
      parse(missing);
      expect.unreachable("expected INVALID_CATALOG");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogError);
      expect((error as CatalogError).code).toBe("INVALID_CATALOG");
    }
    // An omitted section stays additive: no declared policy, no reviewed points.
    const unreviewed = parse(MINIMAL);
    expect(unreviewed.pointPolicy?.size).toBe(0);
    expect(unreviewed.points).toEqual([]);
  });

  it("fails closed when a pi model declares no reasoning axis", () => {
    // The pi runtime always launches with a thinking setting: an undeclared
    // axis would mint a bare point the compiler rejects at start time.
    const stripped = VALID.replace(
      "{model: openai/pi-pro, supportedReasoning: [off, low, medium, high, xhigh, max]}",
      "{model: openai/pi-pro}",
    );
    expect(() => parse(stripped)).toThrow(CatalogError);
    try {
      parse(stripped);
      expect.unreachable("expected INVALID_CATALOG");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogError);
      expect((error as CatalogError).code).toBe("INVALID_CATALOG");
    }
    // Duplicate model entries are equally invalid.
    const duplicated = VALID.replace(
      "      - {model: openai/pi-pro, supportedReasoning: [off, low, medium, high, xhigh, max]}",
      "      - {model: openai/pi-pro, supportedReasoning: [off, low, medium, high, xhigh, max]}\n      - {model: openai/pi-pro, supportedReasoning: [low, high]}",
    );
    expect(() => parse(duplicated)).toThrow(CatalogError);
    // Claude effort is optional (haiku is unreasoned): a claude model without
    // an axis stays valid — the adapter emits no --effort for it.
    const unreasonedClaude = VALID
      .replace("{model: claude-sonnet-5, supportedReasoning: [low, medium, high, max]}", "{model: claude-sonnet-5}")
      .replace(/ {2}claude:claude-sonnet-5:(low|medium|high|max): \{costClass: \w+, latencyClass: \w+\}\n/g, "")
      .replace("  devin:swe-2-max: {costClass: low, latencyClass: low}", "  devin:swe-2-max: {costClass: low, latencyClass: low}\n  claude:claude-sonnet-5: {costClass: medium, latencyClass: medium}");
    expect(() => parse(unreasonedClaude)).not.toThrow();
    // An empty axis is also refused for reasoning-required runners.
    const emptyAxis = VALID.replace(
      "{model: openai/pi-pro, supportedReasoning: [off, low, medium, high, xhigh, max]}",
      "{model: openai/pi-pro, supportedReasoning: []}",
    );
    expect(() => parse(emptyAxis)).toThrow(CatalogError);
    // Model-encoded runners (agy/devin) stay valid without an axis.
    expect(() => parse(MINIMAL)).not.toThrow();
  });

  it("filters operating points by the tier envelope", () => {
    const quota = { provider: "p", billingProduct: "b", account: "a", scope: "account" };
    const points: OperatingPoint[] = [
      { id: "a", runner: "pi", model: "m", reasoning: "off", provider: "p", quota, costClass: "low", latencyClass: "low" },
      { id: "b", runner: "pi", model: "m", reasoning: "high", provider: "p", quota, costClass: "medium", latencyClass: "low" },
      { id: "c", runner: "claude", model: "m", reasoning: "max", provider: "p", quota, costClass: "low", latencyClass: "high" },
      { id: "d", runner: "devin", model: "m", provider: "p", quota, costClass: "extreme", latencyClass: "extreme" },
    ];
    const ids = (tier: QualityTier) => pointsWithinTier(points, tier).map((point) => point.id);
    expect(ids("utility")).toEqual(["a"]);
    expect(ids("economy")).toEqual(["a"]);
    expect(ids("standard")).toEqual(["a", "b"]);
    expect(ids("strong")).toEqual(["a", "b", "c"]);
    expect(ids("frontier")).toEqual(["a", "b", "c", "d"]);
    expect(ids("max")).toEqual(["a", "b", "c", "d"]);
  });

  it("carries the catalog's sha256 revision and honors a caller-supplied digest", () => {
    const catalog = parse();
    expect(catalog.catalogRevision).toBe(catalogRevisionOf(VALID));
    expect(parse(`${VALID}\n# reviewed\n`).catalogRevision).not.toBe(catalog.catalogRevision);
    expect(parseCatalog(VALID, SOURCE, "0".repeat(64)).catalogRevision).toBe("0".repeat(64));
  });
});
