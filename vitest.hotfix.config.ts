import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/hotfix/pi.stdin.hotfix.test.ts", "test/hotfix/mcp.stdio.hotfix.test.ts"],
    bail: 1,
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false
  }
});
