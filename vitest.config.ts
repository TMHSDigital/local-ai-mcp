import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suite must pass with no live runtime and no running model:
    // every network call is mocked and hardware probing is stubbed.
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    globals: false,
  },
});
