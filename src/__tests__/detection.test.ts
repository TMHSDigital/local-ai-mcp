import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { ProviderManager } from "../providers/manager.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetchByHost(opts: {
  ollama?: boolean;
  lmstudio?: boolean;
  llamacpp?: boolean;
  openaicompat?: boolean;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      let live = false;
      if (url.includes(":11434")) live = opts.ollama ?? false;
      else if (url.includes(":1234")) live = opts.lmstudio ?? false;
      else if (url.includes(":8080")) live = opts.llamacpp ?? false;
      else if (url.includes(":8000")) live = opts.openaicompat ?? false;
      return { ok: live, status: live ? 200 : 500, text: async () => "{}" } as unknown as Response;
    }),
  );
}

describe("ProviderManager", () => {
  const config = loadConfig({});

  it("detected() returns only providers that respond", async () => {
    mockFetchByHost({ ollama: true, lmstudio: false, llamacpp: false });
    const mgr = new ProviderManager(config);
    const detected = await mgr.detected(config.detectTimeoutMs);
    expect(detected.map((p) => p.id)).toEqual(["ollama"]);
  });

  it("resolve('ollama') returns ollama", async () => {
    mockFetchByHost({ ollama: true, lmstudio: true, llamacpp: true });
    const mgr = new ProviderManager(config);
    const resolved = await mgr.resolve("ollama", config.detectTimeoutMs);
    expect(resolved.map((p) => p.id)).toEqual(["ollama"]);
  });

  it("resolve('bogus') throws", async () => {
    const mgr = new ProviderManager(config);
    await expect(mgr.resolve("bogus", config.detectTimeoutMs)).rejects.toThrow(/Unknown provider/);
  });

  it("resolve(undefined) returns the detected set", async () => {
    mockFetchByHost({ ollama: true, lmstudio: true, llamacpp: true });
    const mgr = new ProviderManager(config);
    const resolved = await mgr.resolve(undefined, config.detectTimeoutMs);
    expect(resolved.map((p) => p.id).sort()).toEqual(["llamacpp", "lmstudio", "ollama"]);
  });

  it("registers openaicompat only when configured", async () => {
    const withCompat = loadConfig({ OPENAI_COMPAT_HOST: "http://localhost:8000/v1" });
    const mgr = new ProviderManager(withCompat);
    expect(mgr.providers.map((p) => p.id)).toContain("openaicompat");
    expect(new ProviderManager(config).providers.map((p) => p.id)).not.toContain("openaicompat");
  });
});
