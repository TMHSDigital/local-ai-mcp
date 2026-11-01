import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suite must pass with no live runtime and no running model:
    // every network call is mocked and hardware probing is stubbed.
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/index.ts"],
      reporter: ["text-summary", "lcov"],
      // Ratchet: raise these as coverage improves; never lower them.
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 75,
        lines: 80,
      },
    },
  },
});
