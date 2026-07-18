import { httpJson, httpSse } from "../http.js";
import type {
  CompletionChunkHandler,
  CompletionParams,
  CompletionResult,
  ProviderId,
} from "./types.js";

interface OpenAiChatResponse {
  choices?: Array<{
    message?: { content?: string };
    delta?: { content?: string };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Shared OpenAI-compatible chat completion (non-stream and SSE stream).
 * Used by Ollama (/v1), LM Studio (/v1), and Moonshot (/).
 */
export async function openAiChatComplete(
  url: string,
  provider: ProviderId,
  params: CompletionParams,
  timeoutMs: number,
  opts: {
    headers?: Record<string, string>;
    onChunk?: CompletionChunkHandler;
  } = {},
): Promise<CompletionResult> {
  const messages = params.messages ?? [{ role: "user", content: params.prompt ?? "" }];
  const start = Date.now();
  const baseBody = {
    model: params.model,
    messages,
    max_tokens: params.maxTokens,
    temperature: params.temperature,
    stop: params.stop,
  };
  const headers = opts.headers;

  if (!opts.onChunk) {
    const data = await httpJson<OpenAiChatResponse>(url, {
      method: "POST",
      headers,
      body: JSON.stringify(baseBody),
      timeoutMs,
    });
    return {
      provider,
      model: params.model,
      text: data.choices?.[0]?.message?.content ?? "",
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      totalDurationMs: Date.now() - start,
      streamed: false,
    };
  }

  let text = "";
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  await httpSse(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ ...baseBody, stream: true }),
      timeoutMs,
    },
    async (raw) => {
      let parsed: OpenAiChatResponse;
      try {
        parsed = JSON.parse(raw) as OpenAiChatResponse;
      } catch {
        return;
      }
      const delta = parsed.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        text += delta;
        await opts.onChunk!({ text: delta, done: false });
      }
      if (parsed.usage?.prompt_tokens !== undefined) {
        promptTokens = parsed.usage.prompt_tokens;
      }
      if (parsed.usage?.completion_tokens !== undefined) {
        completionTokens = parsed.usage.completion_tokens;
      }
    },
  );

  await opts.onChunk({ text: "", done: true });

  return {
    provider,
    model: params.model,
    text,
    promptTokens,
    completionTokens,
    totalDurationMs: Date.now() - start,
    streamed: true,
  };
}
