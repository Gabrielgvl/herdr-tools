import { fatalLine, runHerdrMcpServer } from "./mcp/run.js";

runHerdrMcpServer().catch((error: unknown) => {
  process.stderr.write(fatalLine(error));
  process.exitCode = 1;
});
