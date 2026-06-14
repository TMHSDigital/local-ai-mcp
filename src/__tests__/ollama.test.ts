import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaProvider } from "../providers/ollama.js";

const HOST = "http://localhost:11434";
const TIMEOUT = 5000;

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: Recorded[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const { status = 200, body } = handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OllamaProvider", () => {
  it("listModels maps /api/tags", async () => {
    mockFetch(() => ({
      body: {
        models: [
          {
            name: "llama3.2:3b",
            size: 2000000000,
            modified_at: "2024-01-01T00:00:00Z",
            details: { family: "llama", parameter_size: "3B", quantization_level: "Q4_K_M" },
          },
        ],
      },
    }));
    const p = new OllamaProvider(HOST);
    const models = await p.listModels(TIMEOUT);
    expect(models).toEqual([
      {
        id: "llama3.2:3b",
        provider: "ollama",
        sizeBytes: 2000000000,
        family: "llama",
        parameterSize: "3B",
        quantization: "Q4_K_M",
        modifiedAt: "2024-01-01T00:00:00Z",
      },
    ]);
  });

  it("listLoaded maps /api/ps", async () => {
    const calls = mockFetch(() => ({
      body: {
        models: [
          { name: "llama3.2:3b", size_vram: 3000000000, expires_at: "2024-01-01T01:00:00Z", context_length: 8192 },
        ],
      },
    }));
    const p = new OllamaProvider(HOST);
    const loaded = await p.listLoaded(TIMEOUT);
    expect(calls[0].url).toBe(`${HOST}/api/ps`);
    expect(loaded[0]).toEqual({
      id: "llama3.2:3b",
      provider: "ollama",
      sizeVramBytes: 3000000000,
      expiresAt: "2024-01-01T01:00:00Z",
      contextLength: 8192,
    });
  });

  it("modelInfo posts /api/show and extracts context_length", async () => {
    const calls = mockFetch(() => ({
      body: {
        details: { family: "llama", parameter_size: "3B", quantization_level: "Q4_K_M" },
        model_info: { "llama.context_length": 131072 },
      },
    }));
    const p = new OllamaProvider(HOST);
    const info = await p.modelInfo("llama3.2:3b", TIMEOUT);
    expect(calls[0].url).toBe(`${HOST}/api/show`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ model: "llama3.2:3b" });
    expect(info.contextLength).toBe(131072);
    expect(info.family).toBe("llama");
  });

  it("complete posts to /v1/chat/completions and builds messages from prompt", async () => {
    const calls = mockFetch(() => ({
      body: {
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      },
    }));
    const p = new OllamaProvider(HOST);
    const res = await p.complete({ model: "llama3.2:3b", prompt: "hi", maxTokens: 10 }, TIMEOUT);
    expect(calls[0].url).toBe(`${HOST}/v1/chat/completions`);
    expect(calls[0].method).toBe("POST");
    expect((calls[0].body as { messages: unknown[] }).messages).toEqual([
      { role: "user", content: "hi" },
    ]);
    expect(res.text).toBe("hello");
    expect(res.completionTokens).toBe(1);
  });

  it("embed posts to /v1/embeddings and reports dimensions", async () => {
    const calls = mockFetch(() => ({
      body: { data: [{ embedding: [0.1, 0.2, 0.3] }] },
    }));
    const p = new OllamaProvider(HOST);
    const res = await p.embed({ model: "nomic-embed-text", input: "x" }, TIMEOUT);
    expect(calls[0].url).toBe(`${HOST}/v1/embeddings`);
    expect(res.embeddings).toEqual([[0.1, 0.2, 0.3]]);
    expect(res.dimensions).toBe(3);
  });

  it("load sends keep_alive and unload sends keep_alive:0", async () => {
    const calls = mockFetch(() => ({ body: {} }));
    const p = new OllamaProvider(HOST);
    await p.load("llama3.2:3b", TIMEOUT, "10m");
    await p.unload("llama3.2:3b", TIMEOUT);
    expect(calls[0].url).toBe(`${HOST}/api/generate`);
    expect((calls[0].body as { keep_alive: unknown }).keep_alive).toBe("10m");
    expect((calls[1].body as { keep_alive: unknown }).keep_alive).toBe(0);
  });

  it("load defaults keep_alive to 5m", async () => {
    const calls = mockFetch(() => ({ body: {} }));
    const p = new OllamaProvider(HOST);
    await p.load("llama3.2:3b", TIMEOUT);
    expect((calls[0].body as { keep_alive: unknown }).keep_alive).toBe("5m");
  });
});
