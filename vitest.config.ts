import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/wait-review.ts", "src/tools/launch.ts", "src/tools/pane.ts", "src/tools/tab.ts", "src/ownership.ts"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100
      },
      reporter: ["text", "json-summary"]
    }
  }
});
