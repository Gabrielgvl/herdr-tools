import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const scripts = join(process.cwd(), "herdr-profiles/profile-plugins/executor/scripts");
const executor = () => import(pathToFileURL(join(scripts, "executor-project-mcp.mjs")).href);
const hindsight = () => import(pathToFileURL(join(scripts, "hindsight-project-mcp.mjs")).href);

describe("direct project memory and shared Executor routing", () => {
  it("binds canonical roots and rejects unmapped, ambiguous, and divergent mappings", async () => {
    const { resolveProjectBank } = await hindsight();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hindsight-project-mcp-")));
    const repo = join(root, "nlp");
    const worktree = join(root, "worktrees", "nlp", "feature");
    const outside = join(root, "nlp-copy");
    for (const dir of [repo, worktree, outside]) mkdirSync(join(dir, "src"), { recursive: true });
    const alias = join(root, "alias");
    symlinkSync(worktree, alias);
    const escape = join(repo, "escape");
    symlinkSync(outside, escape);
    const config = { mapPathToBank: { [repo]: "nlp", [worktree]: "nlp-feature" } };
    expect(resolveProjectBank(config, join(repo, "src"))).toEqual({ bankId: "nlp", projectRoot: repo, cwd: join(repo, "src") });
    expect(resolveProjectBank(config, join(alias, "src"))).toEqual({ bankId: "nlp-feature", projectRoot: worktree, cwd: join(worktree, "src") });
    for (const cwd of [escape, outside]) expect(() => resolveProjectBank(config, cwd)).toThrow("No Hindsight bank is mapped");
    expect(() => resolveProjectBank({ mapPathToBank: { [worktree]: "nlp", [alias]: "other" } }, worktree)).toThrow("Ambiguous Hindsight bank");
    expect(() => resolveProjectBank({ mapPathToBank: { [alias]: "nlp" } }, worktree)).toThrow("mapping differs");
    expect(() => resolveProjectBank({ ...config, banks: { nlp: { bank: "other" } } }, repo)).toThrow("bank override differs");
    expect(() => resolveProjectBank({ mapPathToBank: { [repo]: "" } }, repo)).toThrow("mapping is invalid");
  });

  it("validates the effective per-harness mapping rather than ignoring overrides", async () => {
    const { resolveHarnessConfig, resolveProjectBank } = await hindsight();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hindsight-harness-")));
    const raw = { mapPathToBank: { [root]: "base" }, harnesses: { codex: { mapPathToBank: { [root]: "codex" } } } };
    expect(resolveProjectBank(resolveHarnessConfig(raw, "pi"), root).bankId).toBe("base");
    expect(resolveProjectBank(resolveHarnessConfig(raw, "codex"), root).bankId).toBe("codex");
    expect(() => resolveHarnessConfig(raw, "unknown")).toThrow("supported Hindsight harness");
  });

  it("keeps ordinary Executor connections and excludes every memory bank", async () => {
    const { desiredConnectionPatterns } = await executor();
    expect(desiredConnectionPatterns([
      { address: "tools.github.org.courier", integration: "github" },
      { address: "tools.linear.user.courier", integration: "linear" },
      { address: "tools.hindsight.org.default", integration: "hindsight" },
      { address: "tools.hindsight-bank-aaaaaaaaaaaaaaaa.user.default", integration: "hindsight-bank-aaaaaaaaaaaaaaaa" },
      { address: "tools.hindsight-bank-bbbbbbbbbbbbbbbb.user.default", integration: "hindsight-bank-bbbbbbbbbbbbbbbb" },
    ])).toEqual(["github.org.courier.*", "linear.user.courier.*"]);
  });

  it("preserves the generic Executor tools and their request/results", async () => {
    const { createProxyHandlers, executorToolkitUrl } = await executor();
    let forwarded: unknown;
    const upstream = {
      listTools: async () => ({ tools: ["execute", "skills", "resume"].map(name => ({ name })) }),
      callTool: async (params: unknown) => { forwarded = params; return { content: [{ type: "text", text: "ok" }] }; },
    };
    const handlers = createProxyHandlers(upstream);
    expect(executorToolkitUrl("https://executor.example/mcp/toolkits/coding-agents")).toBe("https://executor.example/mcp/toolkits/coding-agents?artifacts=false");
    expect((await handlers.listTools()).tools.map(({ name }: { name: string }) => name)).toEqual(["execute", "skills", "resume"]);
    const params = { name: "execute", arguments: { code: "return 1" } };
    expect(await handlers.callTool({ params })).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(forwarded).toEqual(params);
  });
});
