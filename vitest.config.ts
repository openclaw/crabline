import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["src/bin/**", "src/providers/types.ts", "test/**"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        branches: 60,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    environment: "node",
    exclude: [...configDefaults.exclude, "dist/**"],
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
  },
});
