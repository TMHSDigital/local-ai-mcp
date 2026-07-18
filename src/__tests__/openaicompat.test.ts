import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatProvider } from "../providers/openaicompat.js";

const HOST = "http://localhost:8000/v1";
const TIMEOUT = 5000;

interface Recorded {
  url: string;
  method: string;
  body: unknown;
  headers?: HeadersInit;
}

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: Recorded[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      headers: init?.headers,
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

describe("OpenAICompatProvider", () => {
  it("listModels maps /models", async () => {
    mockFetch(() => ({ body: { data: [{ id: "mistral", owned_by: "vllm" }] } }));
    const p = new OpenAICompatProvider(HOST);
    const models = await p.listModels(TIMEOUT);
    expect(models).toEqual([{ id: "mistral", provider: "openaicompat", family: "vllm" }]);
  });

  it("complete posts to /chat/completions", async () => {
    const calls = mockFetch(() => ({
      body: { choices: [{ message: { content: "hi" } }], usage: { completion_tokens: 1 } },
    }));
    const p = new OpenAICompatProvider(HOST, "secret");
    const res = await p.complete({ model: "mistral", prompt: "x" }, TIMEOUT);
    expect(calls[0].url).toBe(`${HOST}/chat/completions`);
    expect(res.text).toBe("hi");
    expect(res.provider).toBe("openaicompat");
  });

  it("capabilities are inference-only", () => {
    const caps = new OpenAICompatProvider(HOST).capabilities();
    expect(caps).toMatchObject({
      complete: true,
      embed: true,
      pull: false,
      load: false,
    });
  });

  it("pull/load throw", async () => {
    const p = new OpenAICompatProvider(HOST);
    await expect(p.pull("m", TIMEOUT)).rejects.toThrow(/does not support pull/);
    await expect(p.load("m", TIMEOUT)).rejects.toThrow(/does not support load/);
  });
});
