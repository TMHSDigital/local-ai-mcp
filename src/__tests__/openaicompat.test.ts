import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatProvider } from "../providers/openaicompat.js";
import { mockFetch } from "./support.js";

const OPTS = { timeoutMs: 5000 };

afterEach(() => vi.unstubAllGlobals());

describe("OpenAICompatProvider", () => {
  it("infers local vs hosted from the host, with an override", () => {
    expect(new OpenAICompatProvider("http://localhost:8000/v1").kind).toBe("local");
    expect(new OpenAICompatProvider("https://api.example.com/v1").kind).toBe("hosted");
    expect(new OpenAICompatProvider("https://box.example.com/v1", { kind: "local" }).kind).toBe("local");
  });

  it("lists models with max_model_len as context length, using auth", async () => {
    const calls = mockFetch(() => ({ body: { data: [{ id: "m", owned_by: "vllm", max_model_len: 32768 }] } }));
    const p = new OpenAICompatProvider("http://localhost:8000/v1", { apiKey: "k", name: "jan" });
    expect(await p.listModels(OPTS)).toEqual([{ id: "m", provider: "jan", family: "vllm", contextLength: 32768 }]);
    expect(calls[0].headers.Authorization).toBe("Bearer k");
    expect(await p.listLoaded(OPTS)).toEqual([{ id: "m", provider: "jan", contextLength: 32768 }]);
  });

  it("detects with a single probe", async () => {
    const calls = mockFetch(() => ({ status: 500 }));
    expect(await new OpenAICompatProvider("http://localhost:8000/v1").detect(OPTS)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("orders embeddings by index and checks the count", async () => {
    mockFetch(() => ({ body: { data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] } }));
    const r = await new OpenAICompatProvider("http://localhost:8000/v1").embed({ model: "e", input: ["a", "b"] }, OPTS);
    expect(r.embeddings).toEqual([[1], [2]]);
  });
});
