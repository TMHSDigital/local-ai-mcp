import { afterEach, describe, expect, it, vi } from "vitest";
import { LlamaCppProvider } from "../providers/llamacpp.js";
import { ModelNotFoundError } from "../providers/types.js";
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

  describe("listLoaded /props fallback", () => {
    const PROPS = { model_path: "/m/Qwen-7B-Q4_K_M.gguf", default_generation_settings: { n_ctx: 8192 } };

    it.each([
      ["/slots returns 501", { status: 501, text: "slots disabled" }],
      ["/slots returns []", { body: [] }],
      ["slots have no model field", { body: [{ id: 0, n_ctx: 4096 }, { id: 1, params: {} }] }],
    ])("uses /props when %s", async (_label, slotsReply) => {
      mockFetch((url) => (url.endsWith("/slots") ? slotsReply : { body: PROPS }));
      expect(await new LlamaCppProvider(HOST).listLoaded(OPTS)).toEqual([
        { id: "Qwen-7B-Q4_K_M.gguf", provider: "llamacpp", contextLength: 8192 },
      ]);
    });

    it("takes the file name from a Windows-style model_path", async () => {
      mockFetch((url) =>
        url.endsWith("/slots") ? { status: 501, text: "" } : { body: { model_path: "C:\\m\\x.gguf" } },
      );
      expect((await new LlamaCppProvider(HOST).listLoaded(OPTS)).map((m) => m.id)).toEqual(["x.gguf"]);
    });

    it("prefers model_alias over model_path", async () => {
      mockFetch((url) =>
        url.endsWith("/slots") ? { status: 501, text: "" } : { body: { ...PROPS, model_alias: "qwen-7b" } },
      );
      expect((await new LlamaCppProvider(HOST).listLoaded(OPTS)).map((m) => m.id)).toEqual(["qwen-7b"]);
    });

    it("returns [] without throwing when both endpoints fail", async () => {
      mockFetch(() => ({ status: 500, text: "boom" }));
      expect(await new LlamaCppProvider(HOST).listLoaded(OPTS)).toEqual([]);
    });
  });

  describe("modelInfo", () => {
    const PROPS = { model_path: "/m/x.gguf", default_generation_settings: { n_ctx: 16384 } };

    it("returns contextLength from /props n_ctx with details", async () => {
      mockFetch((url) => (url.endsWith("/v1/models") ? { body: { data: [{ id: "x.gguf" }] } } : { body: PROPS }));
      const info = await new LlamaCppProvider(HOST).modelInfo("x.gguf", OPTS);
      expect(info).toMatchObject({ id: "x.gguf", provider: "llamacpp", contextLength: 16384, details: PROPS });
    });

    it("throws ModelNotFoundError for an unknown id", async () => {
      mockFetch((url) => (url.endsWith("/v1/models") ? { body: { data: [{ id: "x.gguf" }] } } : { body: PROPS }));
      await expect(new LlamaCppProvider(HOST).modelInfo("nope", OPTS)).rejects.toBeInstanceOf(ModelNotFoundError);
    });
  });

  describe("health", () => {
    it("is live via /v1/models when /health is 404", async () => {
      const calls = mockFetch((url) => (url.endsWith("/health") ? { status: 404, text: "" } : { body: { data: [] } }));
      expect(await new LlamaCppProvider(HOST).health(OPTS)).toMatchObject({ live: true });
      expect(calls.map((c) => c.url)).toEqual([`${HOST}/health`, `${HOST}/v1/models`]);
    });

    it("reports the original /health error when both fail", async () => {
      mockFetch((url) => (url.endsWith("/health") ? { status: 503, text: "loading" } : { status: 500, text: "" }));
      const h = await new LlamaCppProvider(HOST).health(OPTS);
      expect(h.live).toBe(false);
      expect(h.error).toMatch(/HTTP 503 for GET http:\/\/localhost:8080\/health/);
    });
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
