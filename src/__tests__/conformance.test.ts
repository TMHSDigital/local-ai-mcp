import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../providers/manager.js";
import { PROVIDER_IDS, UnsupportedOperationError, type Provider, type ProviderId } from "../providers/types.js";
import { mockFetch } from "./support.js";

/**
 * Behaviour every adapter must share, regardless of runtime. New adapters
 * get this for free by being constructible through createProvider; add
 * runtime-specific behaviour tests in their own file.
 */
export function describeProviderConformance(type: ProviderId, host: string, apiKey?: string) {
  describe(`${type} conformance`, () => {
    const make = (): Provider => createProvider({ type, name: `${type}-x`, host, apiKey });
    const OPTS = { timeoutMs: 500 };

    afterEach(() => vi.unstubAllGlobals());

    it("reports a consistent identity", () => {
      const p = make();
      const caps = p.capabilities();
      expect(p.type).toBe(type);
      expect(p.name).toBe(`${type}-x`);
      expect(["local", "hosted"]).toContain(p.kind);
      expect(caps).toMatchObject({ provider: p.name, type, kind: p.kind });
      expect(caps.complete).toBe(true);
    });

    it("detect() never throws when the runtime is down", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }));
      await expect(make().detect(OPTS)).resolves.toBeTypeOf("boolean");
    });

    it("health() reports live:false with an error instead of throwing", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }));
      const h = await make().health(OPTS);
      expect(h).toMatchObject({ live: false, type });
      expect(h.error).toBeTruthy();
    });

    it("unsupported lifecycle operations throw UnsupportedOperationError without network calls", async () => {
      const calls = mockFetch(() => ({ status: 500 }));
      const p = make();
      const caps = p.capabilities();
      const ops: Array<[keyof typeof caps, () => Promise<unknown>]> = [
        ["pull", () => p.pull("m", OPTS)],
        ["remove", () => p.remove("m", OPTS)],
        ["embed", () => p.embed({ model: "m", input: "x" }, OPTS)],
      ];
      for (const [cap, run] of ops) {
        if (caps[cap]) continue;
        await expect(run(), String(cap)).rejects.toBeInstanceOf(UnsupportedOperationError);
      }
      expect(calls).toHaveLength(0);
    });

    it("embeddings, when supported, return one vector per input", async () => {
      const p = make();
      if (!p.capabilities().embed) return;
      mockFetch(() => ({
        body: { data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [2] }], embeddings: [[1], [2]] },
      }));
      const r = await p.embed({ model: "m", input: ["a", "b"] }, OPTS);
      expect(r.embeddings).toHaveLength(2);
      expect(r).toMatchObject({ provider: p.name, local: p.kind === "local" });
    });

    it("completion results say where inference ran", async () => {
      mockFetch(() => ({ body: { choices: [{ message: { content: "ok" } }], message: { content: "ok" }, done: true } }));
      const p = make();
      const r = await p.complete({ model: "m", prompt: "x" }, OPTS);
      expect(r).toMatchObject({ provider: p.name, host: p.host, local: p.kind === "local", text: "ok" });
    });
  });
}

const HOSTS: Record<ProviderId, string> = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234",
  llamacpp: "http://localhost:8080",
  openaicompat: "http://localhost:1337/v1",
  moonshot: "https://api.moonshot.ai/v1",
  dockermodelrunner: "http://localhost:12434",
  mlx: "http://localhost:8081",
  foundrylocal: "http://localhost:5272",
  vllm: "http://localhost:8000",
};

for (const type of PROVIDER_IDS) {
  describeProviderConformance(type, HOSTS[type], type === "moonshot" ? "test-key-not-real" : undefined);
}
