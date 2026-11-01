import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMessages, openAiChatComplete, parseStructured } from "../providers/openai-complete.js";
import { mockFetch } from "./support.js";

const TARGET = { url: "http://srv/v1/chat/completions", provider: "srv", host: "http://srv", local: true };
const OPTS = { timeoutMs: 5000 };

afterEach(() => vi.unstubAllGlobals());

describe("openAiChatComplete", () => {
  it("maps parameters, response_format and image parts", async () => {
    const calls = mockFetch(() => ({ body: { choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }));
    await openAiChatComplete(
      TARGET,
      {
        model: "m",
        system: "sys",
        messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", data: "QQ==", mimeType: "image/jpeg" }] }],
        topP: 0.9,
        seed: 1,
        responseFormat: { type: "json_schema", schema: { type: "object" } },
      },
      OPTS,
    );
    expect(calls[0].body).toEqual({
      model: "m",
      messages: [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [
            { type: "text", text: "see" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,QQ==" } },
          ],
        },
      ],
      top_p: 0.9,
      seed: 1,
      response_format: { type: "json_schema", json_schema: { name: "response", schema: { type: "object" }, strict: true } },
    });
  });

  it("requests usage when streaming and reports it", async () => {
    const calls = mockFetch(() => ({
      chunks: [
        'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"y"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ],
    }));
    const deltas: string[] = [];
    const r = await openAiChatComplete(TARGET, { model: "m", prompt: "x" }, { ...OPTS, onChunk: (c) => void deltas.push(c.text) });
    expect((calls[0].body as Record<string, unknown>).stream_options).toEqual({ include_usage: true });
    expect(deltas).toEqual(["He", "y", ""]);
    expect(r).toMatchObject({ text: "Hey", promptTokens: 3, completionTokens: 2, streamed: true });
    expect(r.usageEstimated).toBeUndefined();
    expect(r.timings?.ttftMs).toBeTypeOf("number");
  });

  it("retries without stream_options when the server rejects it", async () => {
    let n = 0;
    const calls = mockFetch(() => {
      n += 1;
      return n === 1
        ? { status: 400, text: "unknown field stream_options" }
        : { chunks: ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"] };
    });
    const r = await openAiChatComplete(TARGET, { model: "m", prompt: "x" }, { ...OPTS, onChunk: () => undefined });
    expect(calls).toHaveLength(2);
    expect((calls[1].body as Record<string, unknown>).stream_options).toBeUndefined();
    expect(r).toMatchObject({ text: "ok", usageEstimated: true, completionTokens: 1 });
  });

  it("warns that contextLength cannot be applied", async () => {
    mockFetch(() => ({ body: { choices: [{ message: { content: "x" } }] } }));
    const r = await openAiChatComplete(TARGET, { model: "m", prompt: "x", contextLength: 9000 }, OPTS);
    expect(r.applied).toMatchObject({ contextLength: false });
    expect(r.warnings?.[0]).toMatch(/cannot set the context window/);
  });
});

describe("helpers", () => {
  it("buildMessages adds system only when absent", () => {
    expect(buildMessages({ model: "m", prompt: "p", system: "s" })).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "p" },
    ]);
    expect(buildMessages({ model: "m", system: "s", messages: [{ role: "system", content: "keep" }] })).toEqual([
      { role: "system", content: "keep" },
    ]);
  });

  it("parseStructured tolerates fenced JSON and reports invalid output", () => {
    expect(parseStructured('```json\n{"a":1}\n```', true)).toEqual({ parsed: { a: 1 } });
    expect(parseStructured("not json", true).warning).toMatch(/not valid JSON/);
    expect(parseStructured("x", false)).toEqual({});
  });
});
