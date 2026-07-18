import { afterEach, describe, expect, it, vi } from "vitest";
import { openAiChatComplete } from "../providers/openai-complete.js";

const URL = "http://localhost:11434/v1/chat/completions";
const TIMEOUT = 5000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("openAiChatComplete", () => {
  it("non-stream path posts without stream:true and returns text", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.stream).toBeUndefined();
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: "hello" } }],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await openAiChatComplete(URL, "ollama", { model: "m", prompt: "hi" }, TIMEOUT);
    expect(result.text).toBe("hello");
    expect(result.streamed).toBe(false);
    expect(result.completionTokens).toBe(1);
  });

  it("stream path parses SSE deltas and invokes onChunk", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}',
      "data: [DONE]",
      "",
    ].join("\n");

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse));
        controller.close();
      },
    });

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.stream).toBe(true);
      return {
        ok: true,
        status: 200,
        body: stream,
        text: async () => "",
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const chunks: string[] = [];
    const result = await openAiChatComplete(
      URL,
      "ollama",
      { model: "m", prompt: "hi" },
      TIMEOUT,
      {
        onChunk: async ({ text, done }) => {
          if (!done && text) chunks.push(text);
        },
      },
    );

    expect(chunks).toEqual(["Hel", "lo"]);
    expect(result.text).toBe("Hello");
    expect(result.streamed).toBe(true);
    expect(result.completionTokens).toBe(2);
  });
});
