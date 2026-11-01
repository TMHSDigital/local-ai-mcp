import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { ProviderManager, createProvider, sameModel } from "../providers/manager.js";
import { FakeProvider } from "./support.js";

const OPTS = { timeoutMs: 100 };

function mgr(providers: FakeProvider[], over: { allowHostedFallback?: boolean; cacheTtlMs?: number; now?: () => number } = {}) {
  return new ProviderManager(
    { providers: [], allowHostedFallback: over.allowHostedFallback ?? false, cacheTtlMs: over.cacheTtlMs ?? 0 },
    { providers, now: over.now },
  );
}

describe("createProvider", () => {
  it("builds every configured adapter with its instance name and kind", () => {
    const cfg = loadConfig({
      MOONSHOT_API_KEY: "k",
      OPENAI_COMPAT_HOST: "https://remote.example.com/v1",
      MLX_HOST: "localhost:8081",
      VLLM_HOST: "localhost:8000",
      FOUNDRY_LOCAL_HOST: "localhost:5272",
    });
    const ps = cfg.providers.map(createProvider);
    expect(ps.map((p) => p.type).sort()).toEqual(
      ["dockermodelrunner", "foundrylocal", "llamacpp", "lmstudio", "mlx", "moonshot", "ollama", "openaicompat", "vllm"].sort(),
    );
    expect(ps.find((p) => p.type === "moonshot")?.kind).toBe("hosted");
    expect(ps.find((p) => p.type === "openaicompat")?.kind).toBe("hosted");
    expect(ps.find((p) => p.type === "ollama")?.kind).toBe("local");
  });
});

describe("sameModel", () => {
  it("treats :latest as implicit", () => {
    expect(sameModel("llama3", "llama3:latest")).toBe(true);
    expect(sameModel("llama3:8b", "llama3")).toBe(false);
  });
});

describe("ProviderManager detection cache", () => {
  it("caches live results for the TTL and re-probes after invalidate", async () => {
    let t = 0;
    const a = new FakeProvider("a");
    const m = mgr([a], { cacheTtlMs: 10000, now: () => t });
    await m.detected(OPTS);
    await m.detected(OPTS);
    expect(a.calls.filter((c) => c.op === "detect")).toHaveLength(1);
    t = 20000;
    await m.detected(OPTS);
    expect(a.calls.filter((c) => c.op === "detect")).toHaveLength(2);
    m.invalidate("a");
    await m.detected(OPTS);
    expect(a.calls.filter((c) => c.op === "detect")).toHaveLength(3);
  });

  it("re-probes down providers sooner than live ones", async () => {
    let t = 0;
    const a = new FakeProvider("a");
    a.live = false;
    const m = mgr([a], { cacheTtlMs: 10000, now: () => t });
    await m.detected(OPTS);
    t = 4000;
    await m.detected(OPTS);
    expect(a.calls.filter((c) => c.op === "detect")).toHaveLength(2);
  });

  it("caches model listings", async () => {
    const a = new FakeProvider("a", { models: ["x"] });
    const m = mgr([a], { cacheTtlMs: 10000 });
    await m.listModelsCached(a, OPTS);
    await m.listModelsCached(a, OPTS);
    expect(a.calls.filter((c) => c.op === "listModels")).toHaveLength(1);
  });
});

describe("ProviderManager.select", () => {
  it("routes to the provider that has the model", async () => {
    const ollama = new FakeProvider("ollama", { models: ["llama3.2:3b"] });
    const lms = new FakeProvider("lmstudio", { type: "lmstudio", models: ["qwen2.5-7b-instruct"] });
    const m = mgr([ollama, lms]);
    expect((await m.select(undefined, "qwen2.5-7b-instruct", OPTS, { capability: "complete" })).name).toBe("lmstudio");
    expect((await m.select(undefined, "llama3.2:3b", OPTS, { capability: "complete" })).name).toBe("ollama");
  });

  it("prefers the provider where the model is already loaded", async () => {
    const a = new FakeProvider("a", { models: ["m"] });
    const b = new FakeProvider("b", { models: ["m"], loaded: ["m"] });
    expect((await mgr([a, b]).select(undefined, "m", OPTS, { capability: "complete" })).name).toBe("b");
  });

  it("never picks a hosted provider implicitly", async () => {
    const hosted = new FakeProvider("moonshot", { type: "moonshot", kind: "hosted", models: ["kimi-k3"] });
    const local = new FakeProvider("ollama", { models: ["llama3"] });
    const m = mgr([local, hosted]);
    await expect(m.select(undefined, "kimi-k3", OPTS, { capability: "complete" })).rejects.toThrow(
      /not found on any live local provider[\s\S]*moonshot are configured but never used implicitly/,
    );
    local.live = false;
    m.invalidate();
    await expect(m.select(undefined, "kimi-k3", OPTS, { capability: "complete" })).rejects.toThrow(
      /No live local provider supports complete/,
    );
  });

  it("uses hosted providers when explicitly named or when fallback is enabled", async () => {
    const hosted = new FakeProvider("moonshot", { type: "moonshot", kind: "hosted", models: ["kimi-k3"] });
    expect((await mgr([hosted]).select("moonshot", "kimi-k3", OPTS, { capability: "complete" })).name).toBe("moonshot");
    expect(
      (await mgr([hosted], { allowHostedFallback: true }).select(undefined, "kimi-k3", OPTS, { capability: "complete" })).name,
    ).toBe("moonshot");
  });

  it("checks capabilities and filters incapable providers", async () => {
    const noPull = new FakeProvider("llamacpp", { type: "llamacpp", caps: { pull: false } });
    const ollama = new FakeProvider("ollama");
    const m = mgr([noPull, ollama]);
    await expect(m.select("llamacpp", "x", OPTS, { capability: "pull" })).rejects.toThrow(/does not support pull/);
    expect((await m.select(undefined, "x", OPTS, { capability: "pull", allowMissing: true })).name).toBe("ollama");
  });

  it("errors for unknown providers and resolves by type when unambiguous", async () => {
    const a = new FakeProvider("ollama-gpu2", { type: "ollama" });
    const m = mgr([a]);
    expect(m.get("ollama")?.name).toBe("ollama-gpu2");
    expect(() => m.require("nope")).toThrow(/Unknown provider: nope. Configured providers: ollama-gpu2/);
  });
});
