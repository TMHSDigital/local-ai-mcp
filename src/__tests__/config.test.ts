import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("loadConfig pullTimeoutMs", () => {
  it("defaults pullTimeoutMs to 3600000 (1 hour)", () => {
    const config = loadConfig({});
    expect(config.pullTimeoutMs).toBe(3600000);
  });

  it("reads LOCAL_AI_PULL_TIMEOUT_MS from the environment", () => {
    const config = loadConfig({ LOCAL_AI_PULL_TIMEOUT_MS: "7200000" });
    expect(config.pullTimeoutMs).toBe(7200000);
  });

  it("allows 0 to disable the pull timeout", () => {
    const config = loadConfig({ LOCAL_AI_PULL_TIMEOUT_MS: "0" });
    expect(config.pullTimeoutMs).toBe(0);
  });

  it("falls back to the default for invalid values", () => {
    const config = loadConfig({ LOCAL_AI_PULL_TIMEOUT_MS: "not-a-number" });
    expect(config.pullTimeoutMs).toBe(3600000);
  });
});
