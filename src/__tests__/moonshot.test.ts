import { afterEach, describe, expect, it, vi } from "vitest";
import { MoonshotProvider } from "../providers/moonshot.js";
import { loadConfig } from "../config.js";

const HOST = "https://api.moonshot.ai/v1";
// Sanitized fake key; never a real credential.
const FAKE_KEY = "sk-test-not-a-real-key";
const TIMEOUT = 5000;

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: Recorded[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
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

// Sanitized OpenAI-compatible chat completion response, modeled on the shape
// documented at https://platform.moonshot.ai/docs/api/chat
const CHAT_COMPLETION_BODY = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1700000000,
  model: "kimi-k3",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello from Kimi" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MoonshotProvider config", () => {
  it("defaults host to https://api.moonshot.ai/v1 and reads MOONSHOT_HOST/MOONSHOT_API_KEY", () => {
    const defaults = loadConfig({});
    expect(defaults.moonshotHost).toBe("https://api.moonshot.ai/v1");
    expect(defaults.moonshotApiKey).toBeUndefined();

    const overridden = loadConfig({
      MOONSHOT_HOST: "https://api.moonshot.cn/v1/",
      MOONSHOT_API_KEY: FAKE_KEY,
    });
    expect(overridden.moonshotHost).toBe("https://api.moonshot.cn/v1");
    expect(overridden.moonshotApiKey).toBe(FAKE_KEY);
  });
});

describe("MoonshotProvider", () => {
  it("complete posts to /chat/completions with a Bearer header and maps the response", async () => {
    const calls = mockFetch(() => ({ body: CHAT_COMPLETION_BODY }));
    const p = new MoonshotProvider(HOST, FAKE_KEY);
    const result = await p.complete({ model: "kimi-k3", prompt: "Hello" }, TIMEOUT);

    expect(calls[0].url).toBe(`${HOST}/chat/completions`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(calls[0].body).toMatchObject({
      model: "kimi-k3",
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(result.provider).toBe("moonshot");
    expect(result.model).toBe("kimi-k3");
    expect(result.text).toBe("Hello from Kimi");
    expect(result.promptTokens).toBe(12);
    expect(result.completionTokens).toBe(5);
  });

  it("complete passes through an arbitrary model id unchanged", async () => {
    const calls = mockFetch(() => ({ body: { ...CHAT_COMPLETION_BODY, model: "kimi-k2.6" } }));
    const p = new MoonshotProvider(HOST, FAKE_KEY);
    const result = await p.complete(
      { model: "kimi-k2.6", messages: [{ role: "user", content: "hi" }] },
      TIMEOUT,
    );
    expect((calls[0].body as { model: string }).model).toBe("kimi-k2.6");
    expect(result.model).toBe("kimi-k2.6");
  });

  it("complete throws a clear error when MOONSHOT_API_KEY is missing and makes no request", async () => {
    const calls = mockFetch(() => ({ body: CHAT_COMPLETION_BODY }));
    const p = new MoonshotProvider(HOST, undefined);
    await expect(p.complete({ model: "kimi-k3", prompt: "Hello" }, TIMEOUT)).rejects.toThrow(
      /MOONSHOT_API_KEY is not set/,
    );
    expect(calls).toHaveLength(0);
  });

  it("complete surfaces non-2xx responses as HTTP errors", async () => {
    mockFetch(() => ({
      status: 401,
      body: { error: { message: "invalid api key", type: "auth_error", code: "401" } },
    }));
    const p = new MoonshotProvider(HOST, FAKE_KEY);
    await expect(p.complete({ model: "kimi-k3", prompt: "Hello" }, TIMEOUT)).rejects.toThrow(
      /HTTP 401/,
    );
  });

  it("listModels maps the /models list", async () => {
    const calls = mockFetch(() => ({
      body: {
        object: "list",
        data: [{ id: "kimi-k3", object: "model", owned_by: "moonshot", context_length: 1048576 }],
      },
    }));
    const p = new MoonshotProvider(HOST, FAKE_KEY);
    const models = await p.listModels(TIMEOUT);
    expect(calls[0].url).toBe(`${HOST}/models`);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(models).toEqual([{ id: "kimi-k3", provider: "moonshot", family: "moonshot" }]);
  });

  it("detect is false without an API key and does not call fetch", async () => {
    const calls = mockFetch(() => ({ body: {} }));
    const p = new MoonshotProvider(HOST, undefined);
    expect(await p.detect(TIMEOUT)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("health reports the missing-key error without a network call", async () => {
    const calls = mockFetch(() => ({ body: {} }));
    const p = new MoonshotProvider(HOST, undefined);
    const health = await p.health(TIMEOUT);
    expect(health.live).toBe(false);
    expect(health.error).toMatch(/MOONSHOT_API_KEY is not set/);
    expect(calls).toHaveLength(0);
  });

  it("lifecycle operations are unsupported for the hosted API", async () => {
    const p = new MoonshotProvider(HOST, FAKE_KEY);
    const caps = p.capabilities();
    expect(caps).toMatchObject({ complete: true, embed: false, pull: false, remove: false, load: false, unload: false });
    await expect(p.pull("kimi-k3", TIMEOUT)).rejects.toThrow(/hosted API/);
    await expect(p.remove("kimi-k3", TIMEOUT)).rejects.toThrow(/hosted API/);
    await expect(p.load("kimi-k3", TIMEOUT)).rejects.toThrow(/hosted API/);
    await expect(p.unload("kimi-k3", TIMEOUT)).rejects.toThrow(/hosted API/);
    await expect(p.embed({ model: "kimi-k3", input: "x" }, TIMEOUT)).rejects.toThrow(/embeddings/);
  });
});
