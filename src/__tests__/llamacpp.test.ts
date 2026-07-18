import { afterEach, describe, expect, it, vi } from "vitest";
import { LlamaCppProvider } from "../providers/llamacpp.js";

const HOST = "http://localhost:8080";
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

describe("LlamaCppProvider", () => {
  it("detect probes /health", async () => {
    mockFetch((url) => {
      if (url.endsWith("/health")) return { body: { status: "ok" } };
      return { status: 404, body: {} };
    });
    const p = new LlamaCppProvider(HOST);
    expect(await p.detect(TIMEOUT)).toBe(true);
  });

  it("health reads /health status", async () => {
    mockFetch(() => ({ body: { status: "ok" } }));
    const p = new LlamaCppProvider(HOST);
    const h = await p.health(TIMEOUT);
    expect(h).toMatchObject({ provider: "llamacpp", live: true, version: "ok" });
  });

  it("listLoaded uses /slots when present", async () => {
    mockFetch((url) => {
      if (url.endsWith("/slots")) {
        return {
          body: [
            { id: 0, model: "Qwen2.5-7B-Instruct.gguf", n_ctx: 8192 },
            { id: 1, model: "Qwen2.5-7B-Instruct.gguf", n_ctx: 8192 },
          ],
        };
      }
      return { body: {} };
    });
    const p = new LlamaCppProvider(HOST);
    const loaded = await p.listLoaded(TIMEOUT);
    expect(loaded).toEqual([
      { id: "Qwen2.5-7B-Instruct.gguf", provider: "llamacpp", contextLength: 8192 },
    ]);
  });

  it("listModels falls back to /props model_path", async () => {
    mockFetch((url) => {
      if (url.includes("/v1/models")) return { status: 404, body: {} };
      if (url.endsWith("/props")) {
        return {
          body: {
            model_path: "/models/llama-3.2-3b.gguf",
            default_generation_settings: { n_ctx: 4096 },
          },
        };
      }
      return { body: {} };
    });
    const p = new LlamaCppProvider(HOST);
    const models = await p.listModels(TIMEOUT);
    expect(models[0]?.id).toBe("llama-3.2-3b.gguf");
  });

  it("complete uses /v1/chat/completions", async () => {
    const calls = mockFetch(() => ({
      body: { choices: [{ message: { content: "yo" } }] },
    }));
    const p = new LlamaCppProvider(HOST);
    const res = await p.complete({ model: "m", prompt: "hi" }, TIMEOUT);
    expect(calls[0].url).toBe(`${HOST}/v1/chat/completions`);
    expect(res.text).toBe("yo");
    expect(res.provider).toBe("llamacpp");
  });

  it("host ending in /v1 still hits native /health on root", async () => {
    const calls = mockFetch(() => ({ body: { status: "ok" } }));
    const p = new LlamaCppProvider(`${HOST}/v1`);
    await p.health(TIMEOUT);
    expect(calls[0].url).toBe(`${HOST}/health`);
  });
});
