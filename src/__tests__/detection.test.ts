import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { ProviderManager } from "../providers/manager.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetchByHost(liveOllama: boolean, liveLmstudio: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const isOllama = url.includes(":11434");
      const live = isOllama ? liveOllama : liveLmstudio;
      return { ok: live, status: live ? 200 : 500, text: async () => "{}" } as unknown as Response;
    }),
  );
}

describe("ProviderManager", () => {
  const config = loadConfig({});

  it("detected() returns only providers that respond", async () => {
    mockFetchByHost(true, false);
    const mgr = new ProviderManager(config);
    const detected = await mgr.detected(config.detectTimeoutMs);
    expect(detected.map((p) => p.id)).toEqual(["ollama"]);
  });

  it("resolve('ollama') returns ollama", async () => {
    mockFetchByHost(true, true);
    const mgr = new ProviderManager(config);
    const resolved = await mgr.resolve("ollama", config.detectTimeoutMs);
    expect(resolved.map((p) => p.id)).toEqual(["ollama"]);
  });

  it("resolve('bogus') throws", async () => {
    const mgr = new ProviderManager(config);
    await expect(mgr.resolve("bogus", config.detectTimeoutMs)).rejects.toThrow(/Unknown provider/);
  });

  it("resolve(undefined) returns the detected set", async () => {
    mockFetchByHost(true, true);
    const mgr = new ProviderManager(config);
    const resolved = await mgr.resolve(undefined, config.detectTimeoutMs);
    expect(resolved.map((p) => p.id).sort()).toEqual(["lmstudio", "ollama"]);
  });
});
