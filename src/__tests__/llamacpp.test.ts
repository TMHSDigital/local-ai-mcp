import { afterEach, describe, expect, it, vi } from "vitest";
import { LlamaCppProvider } from "../providers/llamacpp.js";
import { mockFetch } from "./support.js";

const HOST = "http://localhost:8080";
const OPTS = { timeoutMs: 5000 };

afterEach(() => vi.unstubAllGlobals());

describe("LlamaCppProvider", () => {
  it("detects via /health and has no lifecycle", async () => {
    mockFetch((url) => (url.endsWith("/health") ? { body: { status: "ok" } } : { status: 404 }));
    const p = new LlamaCppProvider(HOST);
    expect(await p.detect(OPTS)).toBe(true);
    expect(p.capabilities()).toMatchObject({ complete: true, embed: true, pull: false, load: false });
    await expect(p.load("m", OPTS)).rejects.toThrow(/does not support load/);
  });

  it("falls back to /props when /v1/models is empty", async () => {
    mockFetch((url) =>
      url.endsWith("/v1/models")
        ? { body: { data: [] } }
        : { body: { model_path: "/models/qwen.gguf", default_generation_settings: { n_ctx: 8192 } } },
    );
    expect(await new LlamaCppProvider(HOST).listModels(OPTS)).toEqual([
      { id: "qwen.gguf", provider: "llamacpp", contextLength: 8192 },
    ]);
  });

  it("lists loaded models from /slots", async () => {
    mockFetch(() => ({ body: [{ id: 0, model: "qwen", n_ctx: 4096 }, { id: 1, model: "qwen", n_ctx: 4096 }] }));
    expect(await new LlamaCppProvider(HOST).listLoaded(OPTS)).toEqual([
      { id: "qwen", provider: "llamacpp", contextLength: 4096 },
    ]);
  });

  it("normalises a /v1 host for native and OpenAI routes", async () => {
    const calls = mockFetch(() => ({ body: { status: "ok" } }));
    await new LlamaCppProvider(`${HOST}/v1`).health(OPTS);
    expect(calls[0].url).toBe(`${HOST}/health`);
  });

  it("embeds every input through the native fallback", async () => {
    let n = 0;
    const calls = mockFetch((url) => {
      if (url.endsWith("/v1/embeddings")) return { status: 404, text: "not found" };
      n += 1;
      return { body: { embedding: [n, n] } };
    });
    const r = await new LlamaCppProvider(HOST).embed({ model: "e", input: ["a", "b", "c"] }, OPTS);
    expect(r.embeddings).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(calls.filter((c) => c.url.endsWith("/embedding")).map((c) => c.body)).toEqual([
      { content: "a" },
      { content: "b" },
      { content: "c" },
    ]);
  });

  it("handles the newer nested native embedding shape", async () => {
    mockFetch((url) => (url.endsWith("/v1/embeddings") ? { status: 500, text: "x" } : { body: [{ embedding: [[9, 8]] }] }));
    const r = await new LlamaCppProvider(HOST).embed({ model: "e", input: "a" }, OPTS);
    expect(r.embeddings).toEqual([[9, 8]]);
  });

  it("reports both errors and a hint when embeddings are unavailable", async () => {
    mockFetch(() => ({ status: 501, text: "embeddings disabled" }));
    await expect(new LlamaCppProvider(HOST).embed({ model: "e", input: "a" }, OPTS)).rejects.toThrow(
      /\/v1\/embeddings: HTTP 501[\s\S]*\/embedding: HTTP 501[\s\S]*--embeddings/,
    );
  });

  it("parses llama.cpp timings from completions", async () => {
    mockFetch(() => ({
      body: {
        choices: [{ message: { content: "hey" } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
        timings: { prompt_ms: 12.5, predicted_ms: 40 },
      },
    }));
    const r = await new LlamaCppProvider(HOST).complete({ model: "m", prompt: "x" }, OPTS);
    expect(r.timings).toEqual({ promptEvalMs: 12.5, evalMs: 40 });
  });
});
