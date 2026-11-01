import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaProvider, parseOllamaArchitecture } from "../providers/ollama.js";
import { mockFetch } from "./support.js";

const HOST = "http://localhost:11434";
const OPTS = { timeoutMs: 5000 };

afterEach(() => vi.unstubAllGlobals());

describe("OllamaProvider", () => {
  it("is local with full lifecycle and context-length support", () => {
    const p = new OllamaProvider(HOST);
    expect(p.kind).toBe("local");
    expect(p.name).toBe("ollama");
    expect(p.capabilities()).toMatchObject({ pull: true, load: true, contextLength: true, structuredOutput: true });
  });

  it("maps /api/tags and /api/ps", async () => {
    mockFetch((url) =>
      url.endsWith("/api/tags")
        ? {
            body: {
              models: [
                {
                  name: "llama3.2:3b",
                  size: 2e9,
                  modified_at: "2024-01-01T00:00:00Z",
                  details: { family: "llama", parameter_size: "3B", quantization_level: "Q4_K_M" },
                },
              ],
            },
          }
        : { body: { models: [{ name: "llama3.2:3b", size: 3e9, size_vram: 2.5e9, expires_at: "x", context_length: 8192 }] } },
    );
    const p = new OllamaProvider(HOST, { name: "ollama-a" });
    expect(await p.listModels(OPTS)).toEqual([
      {
        id: "llama3.2:3b",
        provider: "ollama-a",
        sizeBytes: 2e9,
        family: "llama",
        parameterSize: "3B",
        quantization: "Q4_K_M",
        modifiedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    expect(await p.listLoaded(OPTS)).toEqual([
      { id: "llama3.2:3b", provider: "ollama-a", sizeBytes: 3e9, sizeVramBytes: 2.5e9, expiresAt: "x", contextLength: 8192 },
    ]);
  });

  it("parses architecture for exact KV sizing from /api/show", async () => {
    mockFetch(() => ({
      body: {
        details: { family: "llama", parameter_size: "8.0B", quantization_level: "Q4_K_M" },
        model_info: {
          "general.architecture": "llama",
          "llama.block_count": 32,
          "llama.attention.head_count": 32,
          "llama.attention.head_count_kv": 8,
          "llama.embedding_length": 4096,
          "llama.context_length": 131072,
        },
      },
    }));
    const info = await new OllamaProvider(HOST).modelInfo("llama3.1:8b", OPTS);
    expect(info.architecture).toEqual({ layers: 32, kvHeads: 8, keyLength: 128, valueLength: 128 });
    expect(info.contextLength).toBe(131072);
  });

  it("averages per-layer KV head arrays", () => {
    const r = parseOllamaArchitecture({
      "general.architecture": "x",
      "x.block_count": 4,
      "x.attention.head_count": 8,
      "x.attention.head_count_kv": [2, 2, 4, 0],
      "x.attention.key_length": 64,
    });
    expect(r.architecture).toEqual({ layers: 4, kvHeads: 2, keyLength: 64, valueLength: 64 });
  });

  it("completes via native /api/chat with num_ctx, options and JSON-schema format", async () => {
    const calls = mockFetch(() => ({
      body: {
        message: { content: '{"name":"Ada"}' },
        done: true,
        load_duration: 2e6,
        prompt_eval_count: 20,
        prompt_eval_duration: 4e6,
        eval_count: 5,
        eval_duration: 50e6,
      },
    }));
    const schema = { type: "object", properties: { name: { type: "string" } } };
    const r = await new OllamaProvider(HOST).complete(
      {
        model: "qwen3:8b",
        system: "be terse",
        prompt: "who?",
        maxTokens: 50,
        temperature: 0.2,
        seed: 7,
        contextLength: 32768,
        responseFormat: { type: "json_schema", schema },
      },
      OPTS,
    );
    expect(calls[0].url).toBe(`${HOST}/api/chat`);
    expect(calls[0].body).toEqual({
      model: "qwen3:8b",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "who?" },
      ],
      options: { num_ctx: 32768, num_predict: 50, temperature: 0.2, seed: 7 },
      format: schema,
      stream: false,
    });
    expect(r).toMatchObject({
      provider: "ollama",
      local: true,
      text: '{"name":"Ada"}',
      parsed: { name: "Ada" },
      promptTokens: 20,
      completionTokens: 5,
      timings: { loadMs: 2, promptEvalMs: 4, evalMs: 50 },
      applied: { contextLength: true, responseFormat: true },
    });
    expect(r.usageEstimated).toBeUndefined();
  });

  it("streams NDJSON, reports ttft, and forwards chunks", async () => {
    mockFetch(() => ({
      chunks: [
        '{"message":{"content":"Hel"},"done":false}\n',
        '{"message":{"content":"lo"},"done":false}\n',
        '{"message":{"content":""},"done":true,"eval_count":2,"prompt_eval_count":3}\n',
      ],
    }));
    const chunks: string[] = [];
    const r = await new OllamaProvider(HOST).complete(
      { model: "m", prompt: "hi" },
      { ...OPTS, onChunk: (c) => void (c.text && chunks.push(c.text)) },
    );
    expect(chunks).toEqual(["Hel", "lo"]);
    expect(r).toMatchObject({ text: "Hello", streamed: true, completionTokens: 2, promptTokens: 3 });
    expect(r.timings?.ttftMs).toBeTypeOf("number");
  });

  it("warns when the prompt was likely truncated", async () => {
    mockFetch(() => ({ body: { message: { content: "x" }, done: true, prompt_eval_count: 2048, eval_count: 1 } }));
    const long = "word ".repeat(10000);
    const r = await new OllamaProvider(HOST).complete({ model: "m", prompt: long }, OPTS);
    expect(r.warnings?.[0]).toMatch(/truncated/);

    mockFetch(() => ({ body: { message: { content: "x" }, done: true, prompt_eval_count: 4096, eval_count: 1 } }));
    const r2 = await new OllamaProvider(HOST).complete({ model: "m", prompt: long, contextLength: 4096 }, OPTS);
    expect(r2.warnings?.[0]).toMatch(/filled the 4096-token context/);
  });

  it("sends image parts as base64 images", async () => {
    const calls = mockFetch(() => ({ body: { message: { content: "a cat" }, done: true } }));
    await new OllamaProvider(HOST).complete(
      {
        model: "llava",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what?" },
              { type: "image", url: "data:image/png;base64,AAAA" },
            ],
          },
        ],
      },
      OPTS,
    );
    expect((calls[0].body as { messages: unknown[] }).messages[0]).toEqual({
      role: "user",
      content: "what?",
      images: ["AAAA"],
    });
  });

  it("pulls with streamed progress", async () => {
    const calls = mockFetch(() => ({
      chunks: [
        '{"status":"pulling manifest"}\n',
        '{"status":"pulling abc","total":100,"completed":40}\n',
        '{"status":"success"}\n',
      ],
    }));
    const progress: unknown[] = [];
    const r = await new OllamaProvider(HOST).pull("qwen3:8b", { ...OPTS, onProgress: (p) => void progress.push(p) });
    expect(calls[0].body).toEqual({ model: "qwen3:8b", stream: true });
    expect(progress).toEqual([
      { status: "pulling manifest" },
      { status: "pulling abc", total: 100, completed: 40 },
      { status: "success" },
    ]);
    expect(r.status).toBe("success");
  });

  it("loads with keep_alive and num_ctx, unloads with keep_alive 0", async () => {
    const calls = mockFetch(() => ({ body: {} }));
    const p = new OllamaProvider(HOST);
    await p.load("m", { ...OPTS, keepAlive: "1h", contextLength: 16384 });
    await p.unload("m", OPTS);
    expect(calls[0].body).toEqual({ model: "m", keep_alive: "1h", options: { num_ctx: 16384 } });
    expect(calls[1].body).toEqual({ model: "m", keep_alive: 0 });
  });

  it("embeds via /api/embed and enforces one vector per input", async () => {
    mockFetch(() => ({ body: { embeddings: [[1, 2], [3, 4]] } }));
    const r = await new OllamaProvider(HOST).embed({ model: "e", input: ["a", "b"] }, OPTS);
    expect(r).toMatchObject({ dimensions: 2, embeddings: [[1, 2], [3, 4]] });

    mockFetch(() => ({ body: { embeddings: [[1, 2]] } }));
    await expect(new OllamaProvider(HOST).embed({ model: "e", input: ["a", "b"] }, OPTS)).rejects.toThrow(
      /1 embedding\(s\) for 2 input/,
    );
  });
});
