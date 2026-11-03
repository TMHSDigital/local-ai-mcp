import { describe, expect, it } from "vitest";
import type { SystemResources } from "../hardware/index.js";
import { ProviderManager } from "../providers/manager.js";
import type { ToolContext } from "../tools/context.js";
import { buildCandidates, type CandidateQuery } from "../tools/delegation.js";
import { FakeProvider, GB, resources } from "./support.js";

const OPTS = { timeoutMs: 100 };
const GPU12: SystemResources = resources({ gpus: [{ name: "gpu", vramFreeBytes: 12 * GB, source: "t" }] });

function ctxFor(providers: FakeProvider[]): ToolContext {
  const manager = new ProviderManager({ providers: [], allowHostedFallback: false, cacheTtlMs: 0 }, { providers });
  return { manager } as unknown as ToolContext;
}

const query = (over: Partial<CandidateQuery> = {}): CandidateQuery => ({
  task: "chat",
  resources: GPU12,
  speedOf: () => undefined,
  ...over,
});

const ids = (r: { candidates: { model: string }[] }) => r.candidates.map((c) => c.model).sort();

describe("buildCandidates", () => {
  it("skips embedding models and dedupes loaded models against listed ones", async () => {
    const p = new FakeProvider("ollama", {
      models: [
        { id: "llama3.1:8b", sizeBytes: 4.9 * GB },
        { id: "nomic-embed-text", sizeBytes: 0.3 * GB },
      ],
      loaded: [{ id: "llama3.1:8b", sizeBytes: 5.5 * GB }],
    });
    const r = await buildCandidates(ctxFor([p]), [p], query(), OPTS);
    expect(ids(r)).toEqual(["llama3.1:8b"]);
    expect(r.candidates[0]).toMatchObject({ tier: "loaded", sizeBytes: 4.9 * GB });
  });

  it("only offers vision-capable models for vision tasks", async () => {
    const p = new FakeProvider("ollama", {
      models: [
        { id: "llava:7b", sizeBytes: 4.7 * GB },
        { id: "llama3.1:8b", sizeBytes: 4.9 * GB },
      ],
    });
    const r = await buildCandidates(ctxFor([p]), [p], query({ task: "vision" }), OPTS);
    expect(ids(r)).toEqual(["llava:7b"]);
    expect(r.candidates[0].specialist).toBe(true);
  });

  it("applies maxSizeBytes before anything else", async () => {
    const p = new FakeProvider("ollama", {
      models: [
        { id: "qwen2.5:14b", sizeBytes: 9 * GB },
        { id: "llama3.1:8b", sizeBytes: 4.9 * GB },
      ],
    });
    const r = await buildCandidates(ctxFor([p]), [p], query({ maxSizeBytes: 5 * GB }), OPTS);
    expect(ids(r)).toEqual(["llama3.1:8b"]);
    expect(r.tooBig).toBe(0);
  });

  it("counts models that fit nowhere and keeps CPU-only ones with their target", async () => {
    const p = new FakeProvider("ollama", {
      models: [
        { id: "huge:405b", sizeBytes: 230 * GB },
        { id: "llama3.1:70b", sizeBytes: 40 * GB },
        { id: "llama3.1:8b", sizeBytes: 4.9 * GB },
      ],
    });
    const hw = resources({ ramFreeBytes: 60 * GB, gpus: [{ name: "gpu", vramFreeBytes: 2 * GB, source: "t" }] });
    const r = await buildCandidates(ctxFor([p]), [p], query({ resources: hw }), OPTS);
    expect(r.tooBig).toBe(1);
    const byId = Object.fromEntries(r.candidates.map((c) => [c.model, c.fitTarget]));
    expect(byId).toEqual({ "llama3.1:70b": "cpu", "llama3.1:8b": "partial" });
  });

  it("does not fit-check hosted providers or attach speeds to them", async () => {
    const hosted = new FakeProvider("cloud", { type: "moonshot", kind: "hosted", models: ["kimi-k3"] });
    const r = await buildCandidates(ctxFor([hosted]), [hosted], query({ speedOf: () => ({}) as never }), OPTS);
    expect(r.candidates[0]).toMatchObject({ model: "kimi-k3", fitTarget: undefined, speed: undefined });
  });

  it("keeps going when one provider fails to list", async () => {
    const broken = new FakeProvider("broken");
    broken.listModels = async () => {
      throw new Error("down");
    };
    const ok = new FakeProvider("ok", { models: [{ id: "llama3.1:8b", sizeBytes: 4.9 * GB }] });
    const r = await buildCandidates(ctxFor([broken, ok]), [broken, ok], query(), OPTS);
    expect(ids(r)).toEqual(["llama3.1:8b"]);
  });
});
