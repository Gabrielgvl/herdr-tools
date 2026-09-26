import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const scriptUrl = pathToFileURL(
  join(process.cwd(), "herdr-profiles/profile-plugins/executor/scripts/executor-project-mcp.mjs"),
).href;

const load = async () => import(scriptUrl);

describe("executor project MCP routing", () => {
  it("resolves the longest canonical mapped root and rejects prefix collisions", async () => {
    const { resolveProjectBank } = await load();
    const root = mkdtempSync(join(tmpdir(), "executor-project-mcp-"));
    const repo = join(root, "nlp");
    const worktree = join(root, "worktrees", "nlp", "feature");
    const outside = join(root, "nlp-copy");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(worktree, "src"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    const alias = join(root, "alias");
    symlinkSync(worktree, alias);
    const escape = join(repo, "escape");
    symlinkSync(outside, escape);

    const config = {
      mapPathToBank: {
        [repo]: "coding-agent::nlp",
        [worktree]: "coding-agent::nlp-feature",
      },
    };

    expect(resolveProjectBank(config, join(repo, "src"))).toEqual({
      bankId: "coding-agent::nlp",
      projectRoot: realpathSync(repo),
    });
    expect(resolveProjectBank(config, join(alias, "src"))).toEqual({
      bankId: "coding-agent::nlp-feature",
      projectRoot: realpathSync(worktree),
    });
    expect(() => resolveProjectBank(config, escape)).toThrow("No Hindsight bank is mapped for this project");
    expect(() => resolveProjectBank(config, outside)).toThrow("No Hindsight bank is mapped for this project");
    expect(() =>
      resolveProjectBank(
        {
          mapPathToBank: {
            [worktree]: "coding-agent::nlp-feature",
            [alias]: "coding-agent::other",
          },
        },
        join(worktree, "src"),
      ),
    ).toThrow("Ambiguous Hindsight bank mapping for this project");
  });

  it("uses one stable integration root for every path sharing a bank", async () => {
    const { resolveProjectBank } = await load();
    const root = mkdtempSync(join(tmpdir(), "executor-project-mcp-"));
    const repo = join(root, "product");
    const clone = join(root, "product-mobile");
    const worktree = join(root, "worktrees", "product", "feature");
    mkdirSync(repo, { recursive: true });
    mkdirSync(clone, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    const config = {
      mapPathToBank: {
        [worktree]: "product-bank",
        [clone]: "product-bank",
        [repo]: "product-bank",
      },
    };

    expect(resolveProjectBank(config, clone)).toEqual({ bankId: "product-bank", projectRoot: realpathSync(repo) });
    expect(resolveProjectBank(config, worktree)).toEqual({ bankId: "product-bank", projectRoot: realpathSync(repo) });
  });

  it("builds stable bank slugs without exposing the bank id", async () => {
    const { bankSlugs } = await load();
    const first = bankSlugs("coding-agent::nlp");
    expect(first).toEqual(bankSlugs("coding-agent::nlp"));
    expect(first.integration).toMatch(/^hindsight-bank-[a-f0-9]{16}$/);
    expect(first.toolkit).toMatch(/^project-memory-[a-f0-9]{16}$/);
    expect(JSON.stringify(first)).not.toContain("coding-agent::nlp");
  });

  it("keeps ordinary Executor connections and selects exactly one memory bank", async () => {
    const { desiredConnectionPatterns } = await load();
    const connections = [
      { address: "tools.github.org.courier", integration: "github" },
      { address: "tools.linear.user.courier", integration: "linear" },
      { address: "tools.hindsight.org.default", integration: "hindsight" },
      { address: "tools.hindsight-bank-aaaaaaaaaaaaaaaa.user.default", integration: "hindsight-bank-aaaaaaaaaaaaaaaa" },
      { address: "tools.hindsight-bank-bbbbbbbbbbbbbbbb.user.default", integration: "hindsight-bank-bbbbbbbbbbbbbbbb" },
    ];

    expect(desiredConnectionPatterns(connections, "hindsight-bank-aaaaaaaaaaaaaaaa")).toEqual([
      "github.org.courier.*",
      "hindsight-bank-aaaaaaaaaaaaaaaa.user.default.*",
      "linear.user.courier.*",
    ]);
  });

  it("preserves the three generic Executor tool names through the local proxy", async () => {
    const { createProxyHandlers, executorToolkitUrl } = await load();
    let forwarded: unknown;
    const upstream = {
      listTools: async () => ({ tools: ["execute", "skills", "resume"].map((name) => ({ name })) }),
      callTool: async (params: unknown) => {
        forwarded = params;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const handlers = createProxyHandlers(upstream);

    expect(executorToolkitUrl("https://executor.example/mcp/toolkits/project-memory-deadbeefdeadbeef")).toBe(
      "https://executor.example/mcp/toolkits/project-memory-deadbeefdeadbeef?artifacts=false",
    );
    expect((await handlers.listTools()).tools.map(({ name }: { name: string }) => name)).toEqual([
      "execute",
      "skills",
      "resume",
    ]);
    await handlers.callTool({ params: { name: "execute", arguments: { code: "return 1" } } });
    expect(forwarded).toEqual({ name: "execute", arguments: { code: "return 1" } });
  });

  it("ships the Claude plugin through the CWD-aware stdio selector", () => {
    const config = JSON.parse(
      readFileSync(
        join(process.cwd(), "herdr-profiles/profile-plugins/executor/mcp-servers.json"),
        "utf8",
      ),
    );
    expect(config.executor).toEqual({
      type: "stdio",
      command: "/home/gabriel/.volta/bin/node",
      args: ["${CLAUDE_PLUGIN_ROOT}/scripts/executor-project-mcp.mjs"],
    });
  });
});
