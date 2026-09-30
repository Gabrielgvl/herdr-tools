import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveHarnessConfig, resolveProjectBank } from "../herdr-profiles/profile-plugins/executor/scripts/hindsight-project-mcp.mjs";

const launcher = join(import.meta.dirname, "../herdr-profiles/profile-plugins/executor/scripts/hindsight-project-mcp.mjs");
const raw = JSON.parse(readFileSync("/home/gabriel/.hindsight/coding-agent.json", "utf8"));
const harnesses = ["pi", "claude-code", "codex", "cursor", "gemini", "opencode", "devin", "agy"];
for (const cwd of ["/home/gabriel/workspace/courier", "/home/gabriel/workspace/nlp"]) {
  for (const harness of harnesses) {
    const expected = resolveProjectBank(resolveHarnessConfig(raw, harness), cwd);
    const client = new Client({ name: "direct-memory-smoke", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [launcher, harness], cwd, stderr: "pipe" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools({}, { timeout: 20_000 });
      assert.equal(tools.length, 8);
      const diagnosis = await client.callTool({ name: "hindsight_diagnose", arguments: {} }, undefined, { timeout: 20_000 });
      assert.ok(!diagnosis.isError);
      const data = JSON.parse(diagnosis.content.find(block => block.type === "text").text);
      assert.equal(data.bank_id, expected.bankId);
      assert.equal(data.workspace, expected.cwd);
      assert.equal(data.harness, harness);
      assert.equal(data.credential.api_token_matches_config, true);
      if (harness === "pi") {
        const pages = await client.callTool({ name: "hindsight_list_knowledge_pages", arguments: {} }, undefined, { timeout: 30_000 });
        assert.ok(!pages.isError, "Live knowledge-page read failed");
      }
      console.log(JSON.stringify({ harness, workspace: cwd, bankMatches: true, directTools: tools.length }));
    } finally { await client.close(); await transport.close(); }
  }
}
const client = new Client({ name: "unmapped-memory-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [launcher, "pi"], cwd: "/tmp", stderr: "pipe" });
try {
  await assert.rejects(() => client.connect(transport));
  console.log(JSON.stringify({ unmappedWorkspaceRejected: true }));
} finally { await client.close(); await transport.close(); }

const executorClient = new Client({ name: "shared-executor-smoke", version: "1.0.0" });
const executorTransport = new StdioClientTransport({
  command: process.execPath,
  args: [join(import.meta.dirname, "../herdr-profiles/profile-plugins/executor/scripts/executor-project-mcp.mjs")],
  cwd: "/tmp",
  stderr: "pipe",
});
try {
  await executorClient.connect(executorTransport);
  const skills = await executorClient.callTool({ name: "skills", arguments: { name: "execute" } }, undefined, { timeout: 30_000 });
  assert.ok(!skills.isError);
  const text = skills.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  assert.ok(!text.includes("hindsight-bank-"));
  assert.ok(!text.includes("- `hindsight`"));
  const result = await executorClient.callTool({ name: "execute", arguments: {
    code: "const r = await tools['github.org.courier.get_me']({}); return { githubAuthenticatedRead: r.ok };",
  } }, undefined, { timeout: 30_000 });
  assert.ok(!result.isError);
  const data = JSON.parse(result.content.find(block => block.type === "text").text);
  assert.equal(data.githubAuthenticatedRead, true);
  console.log(JSON.stringify({ sharedExecutorWithoutProjectMapping: true, memoryExcluded: true, githubAuthenticatedRead: true }));
} finally { await executorClient.close(); await executorTransport.close(); }
