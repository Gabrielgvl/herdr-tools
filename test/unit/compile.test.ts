import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOG_PATH, loadCatalog, parseCatalog, type Catalog, type McpServer, type RunnerPools } from "../../src/catalog.js";
import { compileCandidateContract, CompileError, contractArgv, type ResolvedPoint } from "../../src/compile.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * A fixture scope: real directories so physical containment and plugin manifest
 * reads run for real. `bare` has no manifest, `noname` an unnamed one, `empty`
 * an empty name, and `manager2` a duplicate of `manager`'s plugin name — they
 * exercise every plugin.json outcome the dependency scan can hit.
 */
function scope(): string {
  const root = mkdtempSync(join(tmpdir(), "herdr-compile-"));
  for (const dir of ["skills/adr", "skills/tdd", "ext", "plugins/worker/.claude-plugin", "plugins/executor/.claude-plugin", "plugins/manager/.claude-plugin", "plugins/manager2/.claude-plugin", "plugins/bare", "plugins/noname/.claude-plugin", "plugins/empty/.claude-plugin"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "skills/adr/SKILL.md"), "---\nname: adr\n---\nbody\n");
  writeFileSync(join(root, "skills/tdd/SKILL.md"), "---\nname: tdd\n---\nbody\n");
  writeFileSync(join(root, "ext/host.ts"), "// extension\n");
  writeFileSync(join(root, "plugins/worker/.claude-plugin/plugin.json"), JSON.stringify({ name: "herdr-worker-profile" }));
  writeFileSync(join(root, "plugins/executor/.claude-plugin/plugin.json"), JSON.stringify({ name: "herdr-executor" }));
  writeFileSync(join(root, "plugins/manager/.claude-plugin/plugin.json"), JSON.stringify({ name: "herdr-tools" }));
  writeFileSync(join(root, "plugins/manager2/.claude-plugin/plugin.json"), JSON.stringify({ name: "herdr-tools" }));
  writeFileSync(join(root, "plugins/noname/.claude-plugin/plugin.json"), "{}");
  writeFileSync(join(root, "plugins/empty/.claude-plugin/plugin.json"), JSON.stringify({ name: "" }));
  return root;
}

const catalogAt = (root: string): Catalog => parseCatalog(`version: 2
skills: [skills/adr, skills/tdd, skills/linked]
plugins: [plugins/worker, plugins/executor, plugins/manager, plugins/manager2, plugins/bare, plugins/noname, plugins/empty]
mcp:
  herdr: {plugin: herdr-tools}
  executor: {plugin: herdr-executor}
runners:
  pi:
    models: [{model: openai/pi-pro, supportedReasoning: [low, high]}]
    quota: {provider: openai, billingProduct: codex, account: primary, scope: account}
    defaults: {thinking: high, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: optional, promptDelivery: file, skillSelection: exact, toolSelection: allowlist}
    pools:
      tools: [read, bash, write, mcp, ask_user_question]
      extensions: [ext/host.ts]
      skills: [skills/adr, skills/tdd, skills/linked]
      mcp: [herdr, executor]
  claude:
    models: [{model: claude-opus-5, supportedReasoning: [low, high]}]
    quota: {provider: anthropic, billingProduct: claude, account: primary, scope: account}
    defaults: {effort: high, permissionMode: dontAsk, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: required, promptDelivery: file, skillSelection: additive, toolSelection: allowlist}
    pools:
      tools: [Read, Bash, Write, Skill, NotebookEdit]
      plugins: [plugins/worker, plugins/executor, plugins/manager, plugins/manager2, plugins/bare, plugins/noname, plugins/empty]
      mcp: [herdr, executor]
  agy:
    models: [{model: gemini-low}]
    quota: {provider: google, billingProduct: antigravity, account: primary, scope: account}
    defaults: {mode: plan, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: required, promptDelivery: bootstrap, skillSelection: ambient, toolSelection: ambient}
  devin:
    models: [{model: swe-2-max}]
    quota: {provider: cognition, billingProduct: devin, account: primary, scope: account}
    defaults: {permissionMode: dangerous, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: required, promptDelivery: none, skillSelection: ambient, toolSelection: ambient}
quotaSources:
  - {name: reactive-cooldowns, kind: floor}
pointPolicy:
  pi:openai/pi-pro:low: {costClass: low, latencyClass: low}
  pi:openai/pi-pro:high: {costClass: medium, latencyClass: medium}
  claude:claude-opus-5:low: {costClass: medium, latencyClass: medium}
  claude:claude-opus-5:high: {costClass: high, latencyClass: high}
  agy:gemini-low: {costClass: low, latencyClass: low}
  devin:swe-2-max: {costClass: high, latencyClass: high}
`, { path: `${root}/herdr-profiles/catalog.yaml`, scopeRoot: root });

const SPEC = { label: "worker" };

/** Resolve a fixture operating point by runner kind (and optional reasoning setting). */
function point(catalog: Catalog, runner: string, reasoning?: string): ResolvedPoint {
  const points = catalog.points ?? [];
  const index = points.findIndex((entry) => entry.runner === runner && (reasoning === undefined || entry.reasoning === reasoning));
  if (index < 0) throw new Error(`no ${runner}${reasoning === undefined ? "" : `:${reasoning}`} point in fixture`);
  return { index, point: points[index]!, runner: catalog.runners.get(points[index]!.runner)! };
}

describe("compile", () => {
  it("compiles per point runner: the same spec produces a different recorded contract on each", async () => {
    const catalog = catalogAt(scope());
    const devin = await compileCandidateContract(catalog, SPEC, point(catalog, "devin"), {});
    const claude = await compileCandidateContract(catalog, SPEC, point(catalog, "claude", "high"), { tools: ["Read", "Bash"], plugins: ["plugins/worker"], mcp: ["executor"] });
    const pi = await compileCandidateContract(catalog, SPEC, point(catalog, "pi", "high"), { tools: ["read", "bash"], skills: ["skills/adr"], mcp: ["executor"] });
    const agy = await compileCandidateContract(catalog, SPEC, point(catalog, "agy"), {});
    expect(devin.runtime).toEqual({ kind: "devin", model: "swe-2-max", permissionMode: "dangerous" });
    expect(agy.runtime).toEqual({ kind: "agy", model: "gemini-low", mode: "plan", addDirs: [] });
    expect(claude.runtime).toMatchObject({ kind: "claude", model: "claude-opus-5", effort: "high" });
    expect(pi.runtime).toMatchObject({ kind: "pi", model: "openai/pi-pro", thinking: "high" });
    // Each compilation is recorded with its own point identity and evidence.
    expect([devin, claude, pi, agy].map((contract) => contract.candidate.runner)).toEqual(["devin", "claude", "pi", "agy"]);
    expect([devin, claude, pi, agy].map((contract) => contract.candidate.id)).toEqual(["devin:swe-2-max", "claude:claude-opus-5:high", "pi:openai/pi-pro:high", "agy:gemini-low"]);
    for (const contract of [devin, claude, pi, agy]) {
      expect(contract.specLabel).toBe("worker");
      expect(contract.sessionPersistence).toBe(true);
      expect(contract.timeoutMinutes).toBe(30);
    }
    expect(claude.quota).toEqual({ provider: "anthropic", billingProduct: "claude", account: "primary", scope: "account" });
    expect(pi.plumbing.toolSelection).toBe("allowlist");
    expect(agy.plumbing.promptDelivery).toBe("bootstrap");
    expect(pi.resources.tools!.permitted).toEqual(["read", "bash", "write"]);
    expect(pi.resources.mcp!.permitted).toEqual([]);
    expect(pi.resources.skills!.installed).toHaveLength(3);
  });

  it("fails a selection naming anything outside the pool, carrying the offending names", async () => {
    const catalog = catalogAt(scope());
    const pi = point(catalog, "pi", "high");
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: ["read", "root_shell"] })).rejects.toMatchObject({ name: "CompileError", code: "SELECTION_OUTSIDE_POOL", details: { field: "tools", names: ["root_shell"] } });
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: ["read"], skills: ["skills/nope"] })).rejects.toMatchObject({ code: "SELECTION_OUTSIDE_POOL", details: { field: "skills", names: [`${catalog.source.scopeRoot}/skills/nope`] } });
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: ["read"], mcp: ["bogus-server"] })).rejects.toMatchObject({ code: "SELECTION_OUTSIDE_POOL", details: { field: "mcp", names: ["bogus-server"] } });
    // A path that cannot normalize to a pool member still reports the raw name.
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: ["read"], extensions: ["../escape.ts"] })).rejects.toMatchObject({ code: "SELECTION_OUTSIDE_POOL", details: { field: "extensions", names: ["../escape.ts"] } });
    await expect(compileCandidateContract(catalog, SPEC, point(catalog, "claude", "high"), { tools: ["Read"], plugins: ["plugins/missing"] })).rejects.toMatchObject({ code: "SELECTION_OUTSIDE_POOL", details: { field: "plugins" } });
    // A field the runner cannot consume is the same boundary: every name in it is outside that runner's pool.
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: ["read"], plugins: ["plugins/worker"] })).rejects.toMatchObject({ code: "SELECTION_OUTSIDE_POOL", details: { field: "plugins" } });
    await expect(compileCandidateContract(catalog, SPEC, point(catalog, "agy"), { tools: ["bash"] })).rejects.toMatchObject({ code: "SELECTION_OUTSIDE_POOL", details: { field: "tools", names: ["bash"] } });
    // Rejects with a typed error — nothing is silently dropped, nothing granted.
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: ["read", "root_shell"] })).rejects.toBeInstanceOf(CompileError);
  });

  it("adds the declared MCP provider plugin on claude and removes unscopable ambient MCP on pi", async () => {
    const catalog = catalogAt(scope());
    const root = catalog.source.scopeRoot;
    const claude = await compileCandidateContract(catalog, SPEC, point(catalog, "claude", "high"), { tools: ["Read"], mcp: ["executor"] });
    expect(claude.resources.plugins!.selected).toEqual([]);
    expect(claude.resources.plugins!.exposed).toEqual([`${root}/plugins/executor`]);
    expect(claude.resources.mcp!.permitted).toEqual(["executor"]);
    expect(claude.derivations).toContainEqual({ action: "dependency", field: "plugins", name: `${root}/plugins/executor`, reason: "provides selected MCP server executor" });
    if (claude.runtime.kind === "claude") {
      expect(claude.runtime.pluginDirs).toEqual([`${root}/plugins/executor`]);
      expect(claude.runtime.allowedTools).toEqual(["Read", "Bash", "Write", "mcp__plugin_herdr-executor_executor"]);
    }
    // A dependency already granted by the selection records no derivation.
    const already = await compileCandidateContract(catalog, SPEC, point(catalog, "claude", "high"), { tools: ["Read"], plugins: ["plugins/executor"], mcp: ["executor"] });
    expect(already.derivations.some((derivation) => derivation.action === "dependency")).toBe(false);
    // The `Skill` tool stays permitted when plugin dirs expose reviewed skills.
    const withSkill = await compileCandidateContract(catalog, SPEC, point(catalog, "claude", "high"), { tools: ["Read", "Skill"], plugins: ["plugins/worker"] });
    expect(withSkill.resources.tools!.permitted).toEqual(["Read", "Bash", "Write", "Skill"]);
    const pi = await compileCandidateContract(catalog, SPEC, point(catalog, "pi", "high"), { tools: ["read"], mcp: ["herdr"] });
    expect(pi.resources.tools!.selected).toEqual(["read"]);
    expect(pi.resources.tools!.permitted).toEqual(["read", "bash", "write"]);
    expect(pi.resources.mcp!.selected).toEqual(["herdr"]);
    expect(pi.resources.mcp!.exposed).toEqual([]);
    expect(pi.resources.mcp!.permitted).toEqual([]);
    expect(pi.derivations).toContainEqual({ action: "incompatible", field: "mcp", name: "herdr", reason: "Pi cannot scope ambient MCP servers to the reviewed selection" });
    const piDirect = await compileCandidateContract(catalog, SPEC, point(catalog, "pi", "high"), { tools: ["read", "mcp"], mcp: ["herdr"] });
    expect(piDirect.resources.tools!.selected).toEqual(["read", "mcp"]);
    expect(piDirect.resources.tools!.permitted).toEqual(["read", "bash", "write"]);
    expect(piDirect.derivations).toContainEqual({ action: "incompatible", field: "tools", name: "mcp", reason: "Pi cannot scope ambient MCP servers to the reviewed selection" });
  });

  it("removes incompatible pairs deterministically and records them", async () => {
    const catalog = catalogAt(scope());
    // claude `Skill` with no plugin dirs can only reach unreviewed ambient skills.
    const claude = await compileCandidateContract(catalog, SPEC, point(catalog, "claude", "high"), { tools: ["Read", "Skill"] });
    expect(claude.resources.tools!.selected).toEqual(["Read", "Skill"]);
    expect(claude.resources.tools!.permitted).toEqual(["Read", "Bash", "Write"]);
    expect(claude.derivations).toContainEqual(expect.objectContaining({ action: "incompatible", field: "tools", name: "Skill" }));
    if (claude.runtime.kind === "claude") {
      expect(claude.runtime.allowedTools).toEqual(["Read", "Bash", "Write"]);
      expect(claude.runtime.disallowedTools).toContain("Skill");
    }
    // A selected MCP server whose provider plugin has no directory in the pool is an incompatible pair, removed and recorded.
    const shrunken = catalogAt(scope());
    (shrunken.runners.get("claude")!.pools as { -readonly [K in keyof RunnerPools]: RunnerPools[K] }).plugins = [`${shrunken.source.scopeRoot}/plugins/worker`];
    const removed = await compileCandidateContract(shrunken, SPEC, point(shrunken, "claude", "high"), { tools: ["Read"], mcp: ["executor"] });
    expect(removed.resources.mcp!.selected).toEqual(["executor"]);
    expect(removed.resources.mcp!.permitted).toEqual([]);
    expect(removed.derivations).toContainEqual(expect.objectContaining({ action: "incompatible", field: "mcp", name: "executor", reason: "provider plugin herdr-executor has no directory in the reviewed plugin pool" }));
    if (removed.runtime.kind === "claude") expect(removed.runtime.allowedTools).toEqual(["Read", "Bash", "Write"]);
    // A pool member the catalog never declares a provider for is the same failure.
    const undeclared = catalogAt(scope());
    (undeclared.mcpServers as Map<string, McpServer>).delete("herdr");
    const dropped = await compileCandidateContract(undeclared, SPEC, point(undeclared, "claude", "high"), { tools: ["Read"], mcp: ["herdr"] });
    expect(dropped.derivations).toContainEqual(expect.objectContaining({ action: "incompatible", field: "mcp", name: "herdr", reason: "provider plugin is undeclared in the catalog" }));
    // Same fate on pi when the mcp client tool is not in the pool.
    const piPools = catalogAt(scope());
    (piPools.runners.get("pi")!.pools as { -readonly [K in keyof RunnerPools]: RunnerPools[K] }).tools = ["read", "bash", "write"];
    const piRemoved = await compileCandidateContract(piPools, SPEC, point(piPools, "pi", "high"), { tools: ["read"], mcp: ["herdr"] });
    expect(piRemoved.resources.mcp!.permitted).toEqual([]);
    expect(piRemoved.derivations).toContainEqual(expect.objectContaining({ action: "incompatible", field: "mcp", name: "herdr" }));
  });

  it("keeps installed, exposed, and permitted as three distinct recorded facts", async () => {
    const catalog = catalogAt(scope());
    // Plugin `manager` provides the `herdr` server: selecting the plugin exposes
    // the server ambiently; only selected servers are permitted — the exposed
    // remainder lands on the deny channel.
    const claude = await compileCandidateContract(catalog, SPEC, point(catalog, "claude", "high"), { tools: ["Read", "Bash"], plugins: ["plugins/manager"] });
    const mcp = claude.resources.mcp!;
    expect(mcp.installed).toEqual(["herdr", "executor"]);
    expect(mcp.selected).toEqual([]);
    expect(mcp.exposed).toEqual(["herdr"]);
    expect(mcp.permitted).toEqual([]);
    expect(mcp.denied).toEqual(["herdr"]);
    expect(claude.derivations).toContainEqual(expect.objectContaining({ action: "deny", field: "mcp", name: "herdr" }));
    expect(claude.resources.plugins!.permitted).toEqual([`${catalog.source.scopeRoot}/plugins/manager`]);
    if (claude.runtime.kind === "claude") {
      expect(claude.runtime.allowedTools).toEqual(["Read", "Bash", "Write"]);
      expect(claude.runtime.disallowedTools).toContain("mcp__plugin_herdr-tools_herdr");
    }
    const tools = claude.resources.tools!;
    expect(tools.installed).toEqual(["Read", "Bash", "Write", "Skill", "NotebookEdit"]);
    expect(tools.permitted).toEqual(["Read", "Bash", "Write"]);
    expect(tools.denied).toEqual(["Skill", "NotebookEdit"]);
    expect(claude.gaps).toContainEqual(expect.objectContaining({ kind: "deny-coverage" }));
    expect(claude.gaps).toContainEqual(expect.objectContaining({ kind: "ambient-exposure" }));
  });

  it("is deterministic: same input produces a byte-identical contract regardless of selection order", async () => {
    const catalog = catalogAt(scope());
    const resolved = point(catalog, "claude", "high");
    const forward = { tools: ["Read", "Bash"], plugins: ["plugins/worker", "plugins/executor"], mcp: ["executor", "herdr"] };
    const backward = { mcp: ["herdr", "executor"], plugins: ["plugins/executor", "plugins/worker"], tools: ["Bash", "Read"] };
    const first = await compileCandidateContract(catalog, SPEC, resolved, forward);
    const second = await compileCandidateContract(catalog, SPEC, resolved, backward);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(await compileCandidateContract(catalog, SPEC, resolved, forward))).toBe(JSON.stringify(first));
  });

  it("drives the shared argv builders from the compiled runtime", async () => {
    const catalog = catalogAt(scope());
    const root = catalog.source.scopeRoot;
    const pi = await compileCandidateContract(catalog, SPEC, point(catalog, "pi", "high"), { tools: ["read", "bash"], skills: [`${root}/skills/adr`, "skills/tdd"], extensions: ["ext/host.ts"] });
    expect(contractArgv(pi, "/tmp/prompt.md")).toEqual(["--model", "openai/pi-pro", "--thinking", "high", "--tools", "read,bash,write", "--extension", `${root}/ext/host.ts`, "--no-skills", "--skill", `${root}/skills/adr`, "--skill", `${root}/skills/tdd`, "--append-system-prompt", "/tmp/prompt.md"]);
    // Reasoning comes from the point, never the runner default: `low` wins
    // over the runner's declared `effort: high`.
    const low = await compileCandidateContract(catalog, SPEC, point(catalog, "claude", "low"), { tools: ["Read"] });
    const lowArgv = contractArgv(low, "/tmp/prompt.md");
    expect(lowArgv.slice(lowArgv.indexOf("--effort"), lowArgv.indexOf("--effort") + 2)).toEqual(["--effort", "low"]);
    const claude = await compileCandidateContract(catalog, SPEC, point(catalog, "claude", "high"), { tools: ["Read"], plugins: ["plugins/worker"] });
    expect(contractArgv(claude, "/tmp/prompt.md", "/tmp/att", "/tmp/handoff")).toEqual(["--model", "claude-opus-5", "--effort", "high", "--permission-mode", "dontAsk", ...["Read", "Bash", "Write"].flatMap((tool) => ["--allowed-tools", tool]), ...["Skill", "NotebookEdit"].flatMap((tool) => ["--disallowed-tools", tool]), "--plugin-dir", `${root}/plugins/worker`, "--add-dir", "/tmp/att", "--add-dir", "/tmp/handoff", "--append-system-prompt-file", "/tmp/prompt.md"]);
    const agy = await compileCandidateContract(catalog, SPEC, point(catalog, "agy"), {});
    expect(contractArgv(agy, undefined, "/tmp/att")).toEqual(["--model", "gemini-low", "--mode", "plan", "--dangerously-skip-permissions", "--add-dir", "/tmp/att", "--prompt-interactive", "Initialize this interactive session and reply with exactly AGY_READY."]);
    const devin = await compileCandidateContract(catalog, SPEC, point(catalog, "devin"), {});
    expect(contractArgv(devin)).toEqual(["--model", "swe-2-max", "--permission-mode", "dangerous"]);
  });

  it("binds the reviewed point's quota tuple and identity, never a recomputed candidate", async () => {
    const catalog = catalogAt(scope());
    const resolved = point(catalog, "pi", "high");
    const contract = await compileCandidateContract(catalog, SPEC, resolved, { tools: ["read"] });
    expect(contract.candidate).toEqual({ index: resolved.index, id: "pi:openai/pi-pro:high", runner: "pi", model: "openai/pi-pro", reasoning: "high" });
    expect(contract.quota).toEqual(resolved.point.quota);
  });

  it("fails closed on an unreviewed point, runner mismatch, or reasoning outside the declared axis", async () => {
    const catalog = catalogAt(scope());
    const resolved = point(catalog, "pi", "high");
    await expect(compileCandidateContract(catalog, SPEC, { ...resolved, point: { ...resolved.point, model: "unreviewed/model" } }, { tools: ["read"] })).rejects.toMatchObject({ code: "CANDIDATE_NOT_REVIEWED", details: { model: "unreviewed/model" } });
    await expect(compileCandidateContract(catalog, SPEC, { ...resolved, point: { ...resolved.point, runner: "claude" } }, { tools: ["read"] })).rejects.toMatchObject({ code: "CANDIDATE_NOT_REVIEWED" });
    // Reasoning must be a member of the model's own declared axis.
    await expect(compileCandidateContract(catalog, SPEC, { ...resolved, point: { ...resolved.point, reasoning: "max" } }, { tools: ["read"] })).rejects.toMatchObject({ code: "CANDIDATE_NOT_REVIEWED" });
    // A pi point with no reasoning cannot express argv thinking at all.
    await expect(compileCandidateContract(catalog, SPEC, { ...resolved, point: { ...resolved.point, reasoning: undefined } }, { tools: ["read"] })).rejects.toMatchObject({ code: "CANDIDATE_NOT_REVIEWED" });
    // A claude point carrying a non-effort reasoning setting is equally unreviewed.
    const claude = point(catalog, "claude", "high");
    await expect(compileCandidateContract(catalog, SPEC, { ...claude, point: { ...claude.point, reasoning: "xhigh" } }, { tools: ["Read"] })).rejects.toMatchObject({ code: "CANDIDATE_NOT_REVIEWED" });
    // Even inside the model's declared axis, a claude point's reasoning must be a real effort value.
    const widened = catalogAt(scope());
    widened.runners.get("claude")!.models[0]!.supportedReasoning = ["low", "high", "xhigh"];
    const claudeX = point(widened, "claude", "high");
    await expect(compileCandidateContract(widened, SPEC, { ...claudeX, point: { ...claudeX.point, reasoning: "xhigh" } }, { tools: ["Read"] })).rejects.toMatchObject({ code: "CANDIDATE_NOT_REVIEWED" });
    // A model that declares no reasoning axis at all reviews no reasoned point.
    const axisless = catalogAt(scope());
    delete (axisless.runners.get("pi")!.models[0]! as { supportedReasoning?: unknown }).supportedReasoning;
    await expect(compileCandidateContract(axisless, SPEC, point(axisless, "pi", "high"), { tools: ["read"] })).rejects.toMatchObject({ code: "CANDIDATE_NOT_REVIEWED" });
  });

  it("keeps the unconditional base permit set when Jev selects no tools", async () => {
    const catalog = catalogAt(scope());
    await expect(compileCandidateContract(catalog, SPEC, point(catalog, "pi", "high"), {})).resolves.toMatchObject({ runtime: { tools: ["read", "bash", "write"] } });
    await expect(compileCandidateContract(catalog, SPEC, point(catalog, "claude", "high"), {})).resolves.toMatchObject({ runtime: { allowedTools: ["Read", "Bash", "Write"] } });
    // Ambient runners carry no permit set at all, so the rule does not apply...
    await expect(compileCandidateContract(catalog, SPEC, point(catalog, "agy"), {})).resolves.toMatchObject({ runtime: { kind: "agy" } });
    // ...and a hypothetical ambient runner with allowlist plumbing fails the same way.
    const mutated = catalogAt(scope());
    mutated.runners.get("agy")!.plumbing.toolSelection = "allowlist";
    await expect(compileCandidateContract(mutated, SPEC, point(mutated, "agy"), {})).rejects.toMatchObject({ code: "EMPTY_PERMIT_SET", details: { runner: "agy" } });
    const missingPiBase = catalogAt(scope());
    (missingPiBase.runners.get("pi")!.pools as { -readonly [K in keyof RunnerPools]: RunnerPools[K] }).tools = ["read", "bash"];
    await expect(compileCandidateContract(missingPiBase, SPEC, point(missingPiBase, "pi", "high"), {})).rejects.toMatchObject({ code: "CANDIDATE_NOT_REVIEWED", details: { runner: "pi", names: ["write"] } });
    const missingClaudeBase = catalogAt(scope());
    (missingClaudeBase.runners.get("claude")!.pools as { -readonly [K in keyof RunnerPools]: RunnerPools[K] }).tools = ["Read", "Bash"];
    await expect(compileCandidateContract(missingClaudeBase, SPEC, point(missingClaudeBase, "claude", "high"), {})).rejects.toMatchObject({ code: "CANDIDATE_NOT_REVIEWED", details: { runner: "claude", names: ["Write"] } });
  });

  it("rejects malformed selections before any membership check", async () => {
    const catalog = catalogAt(scope());
    const pi = point(catalog, "pi", "high");
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: "read" as never })).rejects.toMatchObject({ code: "INVALID_SELECTION", details: { field: "tools" } });
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: [5] as never })).rejects.toMatchObject({ code: "INVALID_SELECTION", details: { field: "tools", index: 0 } });
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: [""] })).rejects.toMatchObject({ code: "INVALID_SELECTION" });
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: ["a\nb"] })).rejects.toMatchObject({ code: "INVALID_SELECTION" });
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: ["read"], bogus: ["x"] } as never)).rejects.toMatchObject({ code: "INVALID_SELECTION", details: { field: "bogus" } });
  });

  it("raises PROFILE_SKILL_PATH_ESCAPES_SCOPE on a selected tree that physically escapes the scope", async () => {
    const root = scope();
    const outside = mkdtempSync(join(tmpdir(), "herdr-compile-outside-"));
    symlinkSync(outside, join(root, "skills/linked"), "dir");
    const catalog = catalogAt(root);
    await expect(compileCandidateContract(catalog, SPEC, point(catalog, "pi", "high"), { tools: ["read"], skills: ["skills/linked"] })).rejects.toMatchObject({ code: "PROFILE_SKILL_PATH_ESCAPES_SCOPE" });
  });

  it("compiles the shipped catalog: every reviewed point compiles and real plugin manifests resolve", async () => {
    const catalog = await loadCatalog(join(PACKAGE_ROOT, CATALOG_PATH));
    const root = catalog.source.scopeRoot;
    const points = catalog.points ?? [];
    expect(points.length).toBeGreaterThan(0);
    for (const [index, operatingPoint] of points.entries()) {
      const resolved: ResolvedPoint = { index, point: operatingPoint, runner: catalog.runners.get(operatingPoint.runner)! };
      const selection = operatingPoint.runner === "pi"
        ? { tools: ["read", "herdr_inspect"], skills: [catalog.skills[0]!], mcp: ["herdr"] }
        : operatingPoint.runner === "claude"
          ? { tools: ["Read", "Bash"], mcp: ["executor"] }
          : {};
      const contract = await compileCandidateContract(catalog, SPEC, resolved, selection);
      expect(contract.runtime.kind).toBe(operatingPoint.runner);
      expect(contract.candidate.id).toBe(operatingPoint.id);
      expect(contractArgv(contract).length).toBeGreaterThan(0);
    }
    // The real plugin manifests make `executor`'s provider resolvable: the dependency lands inside the pool.
    const claudeIndex = points.findIndex((entry) => entry.runner === "claude");
    const claudePoint: ResolvedPoint = { index: claudeIndex, point: points[claudeIndex]!, runner: catalog.runners.get("claude")! };
    const contract = await compileCandidateContract(catalog, SPEC, claudePoint, { tools: ["Read"], mcp: ["executor"] });
    expect(contract.resources.plugins!.exposed).toEqual([`${root}/herdr-profiles/profile-plugins/executor`]);
    expect(contract.derivations).toContainEqual(expect.objectContaining({ action: "dependency", field: "plugins", name: `${root}/herdr-profiles/profile-plugins/executor` }));
    // The `herdr` server's declared provider `herdr-tools` has no directory in
    // the reviewed plugin set — the pair is removed as incompatible, recorded.
    const unprovidable = await compileCandidateContract(catalog, SPEC, claudePoint, { tools: ["Read"], mcp: ["herdr"] });
    expect(unprovidable.derivations).toContainEqual(expect.objectContaining({ action: "incompatible", field: "mcp", name: "herdr" }));
  });
});
