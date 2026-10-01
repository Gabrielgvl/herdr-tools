import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["index.ts", "src/**/*.ts"],
      exclude: ["src/mcp-server.ts"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
        perFile: true
      },
      reporter: ["text", "json", "json-summary"]
    }
  }
});
