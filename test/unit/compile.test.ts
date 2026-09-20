import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOG_PATH, loadCatalog, parseCatalog, resolveChain, type Catalog, type McpServer, type ResolvedCandidate, type RunnerPools } from "../../src/catalog.js";
import { compileCandidateContract, CompileError, contractArgv } from "../../src/compile.js";

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

const catalogAt = (root: string): Catalog => parseCatalog(`version: 1
categories:
  frontier:
    - {runner: devin, model: swe-2-max}
    - {runner: claude, model: claude-opus-5}
    - {runner: pi, model: test/pi-pro}
    - {runner: agy, model: gemini-low}
skills: [skills/adr, skills/tdd, skills/linked]
plugins: [plugins/worker, plugins/executor, plugins/manager, plugins/manager2, plugins/bare, plugins/noname, plugins/empty]
mcp:
  herdr: {plugin: herdr-tools}
  executor: {plugin: herdr-executor}
runners:
  pi:
    models: [test/pi-pro]
    quota: {provider: openai, billingProduct: codex, account: primary, scope: account}
    defaults: {thinking: high, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: optional, promptDelivery: file, skillSelection: exact, toolSelection: allowlist}
    pools:
      tools: [read, bash, write, mcp, ask_user_question]
      extensions: [ext/host.ts]
      skills: [skills/adr, skills/tdd, skills/linked]
      mcp: [herdr, executor]
  claude:
    models: [claude-opus-5]
    quota: {provider: anthropic, billingProduct: claude, account: primary, scope: account}
    defaults: {effort: high, permissionMode: dontAsk, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: required, promptDelivery: file, skillSelection: additive, toolSelection: allowlist}
    pools:
      tools: [Read, Bash, Write, Skill, NotebookEdit]
      plugins: [plugins/worker, plugins/executor, plugins/manager, plugins/manager2, plugins/bare, plugins/noname, plugins/empty]
      mcp: [herdr, executor]
  agy:
    models: [gemini-low]
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
`, { path: `${root}/herdr-profiles/catalog.yaml`, scopeRoot: root });

const SPEC = { label: "worker" };

/** Resolve a fixture chain entry by runner kind. */
function candidate(catalog: Catalog, runner: string): ResolvedCandidate {
  const found = resolveChain(catalog, "frontier").chain.map((entry, index) => ({ index, candidate: entry, runner: catalog.runners.get(entry.runner)! })).find((entry) => entry.candidate.runner === runner);
  if (found === undefined) throw new Error(`no ${runner} candidate in fixture`);
  return found;
}

describe("compile", () => {
  it("compiles per candidate runner: the same spec produces a different recorded contract on each", async () => {
    const catalog = catalogAt(scope());
    const devin = await compileCandidateContract(catalog, SPEC, candidate(catalog, "devin"), {});
    const claude = await compileCandidateContract(catalog, SPEC, candidate(catalog, "claude"), { tools: ["Read", "Bash"], plugins: ["plugins/worker"], mcp: ["executor"] });
    const pi = await compileCandidateContract(catalog, SPEC, candidate(catalog, "pi"), { tools: ["read", "bash"], skills: ["skills/adr"], mcp: ["executor"] });
    const agy = await compileCandidateContract(catalog, SPEC, candidate(catalog, "agy"), {});
    expect(devin.runtime).toEqual({ kind: "devin", model: "swe-2-max", permissionMode: "dangerous" });
    expect(agy.runtime).toEqual({ kind: "agy", model: "gemini-low", mode: "plan", addDirs: [] });
    expect(claude.runtime).toMatchObject({ kind: "claude", model: "claude-opus-5" });
    expect(pi.runtime).toMatchObject({ kind: "pi", model: "test/pi-pro", thinking: "high" });
    // Each compilation is recorded with its own identity and evidence.
    expect([devin, claude, pi, agy].map((contract) => contract.candidate.runner)).toEqual(["devin", "claude", "pi", "agy"]);
    expect([devin, claude, pi, agy].map((contract) => contract.candidate.index)).toEqual([0, 1, 2, 3]);
    for (const contract of [devin, claude, pi, agy]) {
      expect(contract.specLabel).toBe("worker");
      expect(contract.sessionPersistence).toBe(true);
      expect(contract.timeoutMinutes).toBe(30);
    }
    expect(claude.quota).toEqual({ provider: "anthropic", billingProduct: "claude", account: "primary", scope: "account" });
    expect(pi.plumbing.toolSelection).toBe("allowlist");
    expect(agy.plumbing.promptDelivery).toBe("bootstrap");
    expect(pi.resources.tools!.permitted).toEqual(["read", "bash", "mcp"]);
    expect(pi.resources.skills!.installed).toHaveLength(3);
  });

  it("fails a selection naming anything outside the pool, carrying the offending names", async () => {
    const catalog = catalogAt(scope());
    const pi = candidate(catalog, "pi");
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: ["read", "root_shell"] })).rejects.toMatchObject({ name: "CompileError", code: "SELECTION_OUTSIDE_POOL", details: { field: "tools", names: ["root_shell"] } });
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: ["read"], skills: ["skills/nope"] })).rejects.toMatchObject({ code: "SELECTION_OUTSIDE_POOL", details: { field: "skills", names: [`${catalog.source.scopeRoot}/skills/nope`] } });
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: ["read"], mcp: ["bogus-server"] })).rejects.toMatchObject({ code: "SELECTION_OUTSIDE_POOL", details: { field: "mcp", names: ["bogus-server"] } });
    // A path that cannot normalize to a pool member still reports the raw name.
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: ["read"], extensions: ["../escape.ts"] })).rejects.toMatchObject({ code: "SELECTION_OUTSIDE_POOL", details: { field: "extensions", names: ["../escape.ts"] } });
    await expect(compileCandidateContract(catalog, SPEC, candidate(catalog, "claude"), { tools: ["Read"], plugins: ["plugins/missing"] })).rejects.toMatchObject({ code: "SELECTION_OUTSIDE_POOL", details: { field: "plugins" } });
    // A field the runner cannot consume is the same boundary: every name in it is outside that runner's pool.
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: ["read"], plugins: ["plugins/worker"] })).rejects.toMatchObject({ code: "SELECTION_OUTSIDE_POOL", details: { field: "plugins" } });
    await expect(compileCandidateContract(catalog, SPEC, candidate(catalog, "agy"), { tools: ["bash"] })).rejects.toMatchObject({ code: "SELECTION_OUTSIDE_POOL", details: { field: "tools", names: ["bash"] } });
    // Rejects with a typed error — nothing is silently dropped, nothing granted.
    await expect(compileCandidateContract(catalog, SPEC, pi, { tools: ["read", "root_shell"] })).rejects.toBeInstanceOf(CompileError);
  });

  it("adds the declared MCP provider plugin on claude and the mcp client tool on pi", async () => {
    const catalog = catalogAt(scope());
    const root = catalog.source.scopeRoot;
    const claude = await compileCandidateContract(catalog, SPEC, candidate(catalog, "claude"), { tools: ["Read"], mcp: ["executor"] });
    expect(claude.resources.plugins!.selected).toEqual([]);
    expect(claude.resources.plugins!.exposed).toEqual([`${root}/plugins/executor`]);
    expect(claude.resources.mcp!.permitted).toEqual(["executor"]);
    expect(claude.derivations).toContainEqual({ action: "dependency", field: "plugins", name: `${root}/plugins/executor`, reason: "provides selected MCP server executor" });
    if (claude.runtime.kind === "claude") {
      expect(claude.runtime.pluginDirs).toEqual([`${root}/plugins/executor`]);
      expect(claude.runtime.allowedTools).toEqual(["Read", "mcp__plugin_herdr-executor_executor"]);
    }
    // A dependency already granted by the selection records no derivation.
    const already = await compileCandidateContract(catalog, SPEC, candidate(catalog, "claude"), { tools: ["Read"], plugins: ["plugins/executor"], mcp: ["executor"] });
    expect(already.derivations.some((derivation) => derivation.action === "dependency")).toBe(false);
    // The `Skill` tool stays permitted when plugin dirs expose reviewed skills.
    const withSkill = await compileCandidateContract(catalog, SPEC, candidate(catalog, "claude"), { tools: ["Read", "Skill"], plugins: ["plugins/worker"] });
    expect(withSkill.resources.tools!.permitted).toEqual(["Read", "Skill"]);
    const pi = await compileCandidateContract(catalog, SPEC, candidate(catalog, "pi"), { tools: ["read"], mcp: ["herdr"] });
    expect(pi.resources.tools!.selected).toEqual(["read"]);
    expect(pi.resources.tools!.permitted).toEqual(["read", "mcp"]);
    expect(pi.derivations).toContainEqual({ action: "dependency", field: "tools", name: "mcp", reason: "MCP server selection requires the mcp client tool" });
    expect(pi.gaps).toContainEqual(expect.objectContaining({ kind: "ambient-exposure" }));
    // Selecting the mcp tool outright needs no derivation.
    const piDirect = await compileCandidateContract(catalog, SPEC, candidate(catalog, "pi"), { tools: ["read", "mcp"], mcp: ["herdr"] });
    expect(piDirect.derivations.some((derivation) => derivation.action === "dependency")).toBe(false);
    expect(piDirect.resources.tools!.permitted).toEqual(["read", "mcp"]);
  });

  it("removes incompatible pairs deterministically and records them", async () => {
    const catalog = catalogAt(scope());
    // claude `Skill` with no plugin dirs can only reach unreviewed ambient skills.
    const claude = await compileCandidateContract(catalog, SPEC, candidate(catalog, "claude"), { tools: ["Read", "Skill"] });
    expect(claude.resources.tools!.selected).toEqual(["Read", "Skill"]);
    expect(claude.resources.tools!.permitted).toEqual(["Read"]);
    expect(claude.derivations).toContainEqual(expect.objectContaining({ action: "incompatible", field: "tools", name: "Skill" }));
    if (claude.runtime.kind === "claude") {
      expect(claude.runtime.allowedTools).toEqual(["Read"]);
      expect(claude.runtime.disallowedTools).toContain("Skill");
    }
    // A selected MCP server whose provider plugin has no directory in the pool is an incompatible pair, removed and recorded.
    const shrunken = catalogAt(scope());
    (shrunken.runners.get("claude")!.pools as { -readonly [K in keyof RunnerPools]: RunnerPools[K] }).plugins = [`${shrunken.source.scopeRoot}/plugins/worker`];
    const removed = await compileCandidateContract(shrunken, SPEC, candidate(shrunken, "claude"), { tools: ["Read"], mcp: ["executor"] });
    expect(removed.resources.mcp!.selected).toEqual(["executor"]);
    expect(removed.resources.mcp!.permitted).toEqual([]);
    expect(removed.derivations).toContainEqual(expect.objectContaining({ action: "incompatible", field: "mcp", name: "executor", reason: "provider plugin herdr-executor has no directory in the reviewed plugin pool" }));
    if (removed.runtime.kind === "claude") expect(removed.runtime.allowedTools).toEqual(["Read"]);
    // A pool member the catalog never declares a provider for is the same failure.
    const undeclared = catalogAt(scope());
    (undeclared.mcpServers as Map<string, McpServer>).delete("herdr");
    const dropped = await compileCandidateContract(undeclared, SPEC, candidate(undeclared, "claude"), { tools: ["Read"], mcp: ["herdr"] });
    expect(dropped.derivations).toContainEqual(expect.objectContaining({ action: "incompatible", field: "mcp", name: "herdr", reason: "provider plugin is undeclared in the catalog" }));
    // Same fate on pi when the mcp client tool is not in the pool.
    const piPools = catalogAt(scope());
    (piPools.runners.get("pi")!.pools as { -readonly [K in keyof RunnerPools]: RunnerPools[K] }).tools = ["read", "bash"];
    const piRemoved = await compileCandidateContract(piPools, SPEC, candidate(piPools, "pi"), { tools: ["read"], mcp: ["herdr"] });
    expect(piRemoved.resources.mcp!.permitted).toEqual([]);
    expect(piRemoved.derivations).toContainEqual(expect.objectContaining({ action: "incompatible", field: "mcp", name: "herdr" }));
  });

  it("keeps installed, exposed, and permitted as three distinct recorded facts", async () => {
    const catalog = catalogAt(scope());
    // Plugin `manager` provides the `herdr` server: selecting the plugin exposes
    // the server ambiently; only selected servers are permitted — the exposed
    // remainder lands on the deny channel.
    const claude = await compileCandidateContract(catalog, SPEC, candidate(catalog, "claude"), { tools: ["Read", "Bash"], plugins: ["plugins/manager"] });
    const mcp = claude.resources.mcp!;
    expect(mcp.installed).toEqual(["herdr", "executor"]);
    expect(mcp.selected).toEqual([]);
    expect(mcp.exposed).toEqual(["herdr"]);
    expect(mcp.permitted).toEqual([]);
    expect(mcp.denied).toEqual(["herdr"]);
    expect(claude.derivations).toContainEqual(expect.objectContaining({ action: "deny", field: "mcp", name: "herdr" }));
    expect(claude.resources.plugins!.permitted).toEqual([`${catalog.source.scopeRoot}/plugins/manager`]);
    if (claude.runtime.kind === "claude") {
      expect(claude.runtime.allowedTools).toEqual(["Read", "Bash"]);
      expect(claude.runtime.disallowedTools).toContain("mcp__plugin_herdr-tools_herdr");
    }
    const tools = claude.resources.tools!;
    expect(tools.installed).toEqual(["Read", "Bash", "Write", "Skill", "NotebookEdit"]);
    expect(tools.permitted).toEqual(["Read", "Bash"]);
    expect(tools.denied).toEqual(["Write", "Skill", "NotebookEdit"]);
    expect(claude.gaps).toContainEqual(expect.objectContaining({ kind: "deny-coverage" }));
    expect(claude.gaps).toContainEqual(expect.objectContaining({ kind: "ambient-exposure" }));
  });

  it("is deterministic: same input produces a byte-identical contract regardless of selection order", async () => {
    const catalog = catalogAt(scope());
    const resolved = candidate(catalog, "claude");
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
    const pi = await compileCandidateContract(catalog, SPEC, candidate(catalog, "pi"), { tools: ["read", "bash"], skills: [`${root}/skills/adr`, "skills/tdd"], extensions: ["ext/host.ts"] });
    expect(contractArgv(pi, "/tmp/prompt.md")).toEqual(["--model", "test/pi-pro", "--thinking", "high", "--tools", "read,bash", "--extension", `${root}/ext/host.ts`, "--no-skills", "--skill", `${root}/skills/adr`, "--skill", `${root}/skills/tdd`, "--append-system-prompt", "/tmp/prompt.md"]);
    const claude = await compileCandidateContract(catalog, SPEC, candidate(catalog, "claude"), { tools: ["Read"], plugins: ["plugins/worker"] });
    expect(contractArgv(claude, "/tmp/prompt.md", "/tmp/att", "/tmp/handoff")).toEqual(["--model", "claude-opus-5", "--effort", "high", "--permission-mode", "dontAsk", "--allowed-tools", "Read", ...["Bash", "Write", "Skill", "NotebookEdit"].flatMap((tool) => ["--disallowed-tools", tool]), "--plugin-dir", `${root}/plugins/worker`, "--add-dir", "/tmp/att", "--add-dir", "/tmp/handoff", "--append-system-prompt-file", "/tmp/prompt.md"]);
    const agy = await compileCandidateContract(catalog, SPEC, candidate(catalog, "agy"), {});
    expect(contractArgv(agy, undefined, "/tmp/att")).toEqual(["--model", "gemini-low", "--mode", "plan", "--dangerously-skip-permissions", "--add-dir", "/tmp/att", "--prompt-interactive", "Initialize this interactive session and reply with exactly AGY_READY."]);
    const devin = await compileCandidateContract(catalog, SPEC, candidate(catalog, "devin"), {});
    expect(contractArgv(devin)).toEqual(["--model", "swe-2-max", "--permission-mode", "dangerous"]);
  });

  it("records the per-candidate account override in the quota evidence", async () => {
    const catalog = catalogAt(scope());
    const resolved = candidate(catalog, "pi");
    const contract = await compileCandidateContract(catalog, SPEC, { ...resolved, candidate: { ...resolved.candidate, account: "secondary" } }, { tools: ["read"] });
    expect(contract.candidate.account).toBe("secondary");
    expect(contract.quota.account).toBe("secondary");
  });

  it("fails closed on an unreviewed candidate or runner mismatch", async () => {
    const catalog = catalogAt(scope());
    const resolved = candidate(catalog, "pi");
    await expect(compileCandidateContract(catalog, SPEC, { ...resolved, candidate: { runner: "pi", model: "unreviewed/model" } }, { tools: ["read"] })).rejects.toMatchObject({ code: "CANDIDATE_NOT_REVIEWED", details: { model: "unreviewed/model" } });
    await expect(compileCandidateContract(catalog, SPEC, { ...resolved, candidate: { runner: "claude", model: "test/pi-pro" } }, { tools: ["read"] })).rejects.toMatchObject({ code: "CANDIDATE_NOT_REVIEWED" });
  });

  it("fails closed when the permit set argv cannot express would grant ambient defaults", async () => {
    const catalog = catalogAt(scope());
    await expect(compileCandidateContract(catalog, SPEC, candidate(catalog, "pi"), {})).rejects.toMatchObject({ code: "EMPTY_PERMIT_SET", details: { runner: "pi" } });
    await expect(compileCandidateContract(catalog, SPEC, candidate(catalog, "claude"), {})).rejects.toMatchObject({ code: "EMPTY_PERMIT_SET", details: { runner: "claude" } });
    // Ambient runners carry no permit set at all, so the rule does not apply...
    await expect(compileCandidateContract(catalog, SPEC, candidate(catalog, "agy"), {})).resolves.toMatchObject({ runtime: { kind: "agy" } });
    // ...and a hypothetical ambient runner with allowlist plumbing fails the same way.
    const mutated = catalogAt(scope());
    mutated.runners.get("agy")!.plumbing.toolSelection = "allowlist";
    await expect(compileCandidateContract(mutated, SPEC, candidate(mutated, "agy"), {})).rejects.toMatchObject({ code: "EMPTY_PERMIT_SET", details: { runner: "agy" } });
  });

  it("rejects malformed selections before any membership check", async () => {
    const catalog = catalogAt(scope());
    const pi = candidate(catalog, "pi");
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
    await expect(compileCandidateContract(catalog, SPEC, candidate(catalog, "pi"), { tools: ["read"], skills: ["skills/linked"] })).rejects.toMatchObject({ code: "PROFILE_SKILL_PATH_ESCAPES_SCOPE" });
  });

  it("compiles the shipped catalog: every chain candidate compiles and real plugin manifests resolve", async () => {
    const catalog = await loadCatalog(join(PACKAGE_ROOT, CATALOG_PATH));
    const root = catalog.source.scopeRoot;
    for (const category of catalog.categories.keys()) {
      const { selected, remainder } = resolveChain(catalog, category);
      for (const resolved of [selected, ...remainder]) {
        if (resolved === undefined) continue;
        const selection = resolved.candidate.runner === "pi"
          ? { tools: ["read", "herdr_inspect"], skills: [catalog.skills[0]!], mcp: ["herdr"] }
          : resolved.candidate.runner === "claude"
            ? { tools: ["Read", "Bash"], mcp: ["executor"] }
            : {};
        const contract = await compileCandidateContract(catalog, SPEC, resolved, selection);
        expect(contract.runtime.kind).toBe(resolved.candidate.runner);
        expect(contractArgv(contract).length).toBeGreaterThan(0);
      }
    }
    // The real plugin manifests make `executor`'s provider resolvable: the dependency lands inside the pool.
    const claudeCandidate = resolveChain(catalog, "frontier").remainder.find((entry) => entry.candidate.runner === "claude")!;
    const contract = await compileCandidateContract(catalog, SPEC, claudeCandidate, { tools: ["Read"], mcp: ["executor"] });
    expect(contract.resources.plugins!.exposed).toEqual([`${root}/herdr-profiles/profile-plugins/executor`]);
    expect(contract.derivations).toContainEqual(expect.objectContaining({ action: "dependency", field: "plugins", name: `${root}/herdr-profiles/profile-plugins/executor` }));
    // The `herdr` server's declared provider `herdr-tools` has no directory in
    // the reviewed plugin set — the pair is removed as incompatible, recorded.
    const unprovidable = await compileCandidateContract(catalog, SPEC, claudeCandidate, { tools: ["Read"], mcp: ["herdr"] });
    expect(unprovidable.derivations).toContainEqual(expect.objectContaining({ action: "incompatible", field: "mcp", name: "herdr" }));
  });
});
