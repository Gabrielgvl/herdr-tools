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
      // CI skips test/unit/skill-bundles.test.ts (it needs canonical skill trees
      // absent from runners), so its source is excluded from the CI coverage
      // gate too. It stays gated locally, where that suite runs.
      exclude: ["src/mcp-server.ts", ...(process.env.CI ? ["src/profiles/skill-bundles.ts"] : [])],
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
