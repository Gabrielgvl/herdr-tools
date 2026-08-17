import { runHerdrMcpServer } from "./mcp/run.js";

runHerdrMcpServer().catch((error: unknown) => {
  process.stderr.write(`herdr-tools mcp server failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
