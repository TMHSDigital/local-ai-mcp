import { HttpError, httpJson, httpSse } from "../http.js";
import type {
  ChatMessage,
  CompletionChunkHandler,
  CompletionParams,
  CompletionResult,
  CompletionTimings,
  ContentPart,
} from "./types.js";

interface OpenAiChatResponse {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
    delta?: { content?: string | null };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  /** llama.cpp server extension. */
  timings?: { prompt_ms?: number; predicted_ms?: number };
}

export interface OpenAiCompleteTarget {
  url: string;
  provider: string;
  host: string;
  local: boolean;
  headers?: Record<string, string>;
}

export interface OpenAiCompleteOptions {
  timeoutMs: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  onChunk?: CompletionChunkHandler;
}

/** Normalise prompt/system/messages into one chat message list. */
export function buildMessages(params: CompletionParams): ChatMessage[] {
  const messages: ChatMessage[] = params.messages
    ? [...params.messages]
    : [{ role: "user", content: params.prompt ?? "" }];
  if (params.system && !messages.some((m) => m.role === "system")) {
    messages.unshift({ role: "system", content: params.system });
  }
  return messages;
}

function toOpenAiContent(content: string | ContentPart[]): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    const url = part.url ?? `data:${part.mimeType ?? "image/png"};base64,${part.data ?? ""}`;
    return { type: "image_url", image_url: { url } };
  });
}

/** Rough token estimate used only when a provider reports no usage. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/**
 * Parse JSON output when a response format was requested. Tolerates a fenced
 * ```json block, which some models emit even in JSON mode.
 */
export function parseStructured(
  text: string,
  requested: boolean,
): { parsed?: unknown; warning?: string } {
  if (!requested) return {};
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return { parsed: JSON.parse(candidate) };
  } catch {
    return { warning: "responseFormat was requested but the output is not valid JSON" };
  }
}

/**
 * Shared OpenAI-compatible chat completion (non-stream and SSE stream).
 */
export async function openAiChatComplete(
  target: OpenAiCompleteTarget,
  params: CompletionParams,
  opts: OpenAiCompleteOptions,
): Promise<CompletionResult> {
  const messages = buildMessages(params).map((m) => ({
    role: m.role,
    content: toOpenAiContent(m.content),
  }));
  const start = Date.now();
  const body: Record<string, unknown> = {
    model: params.model,
    messages,
    max_tokens: params.maxTokens,
    temperature: params.temperature,
    top_p: params.topP,
    top_k: params.topK,
    seed: params.seed,
    repeat_penalty: params.repeatPenalty,
    stop: params.stop,
    ...(params.options ?? {}),
  };
  if (params.responseFormat?.type === "json_object") {
    body.response_format = { type: "json_object" };
  } else if (params.responseFormat?.type === "json_schema") {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: params.responseFormat.name ?? "response",
        schema: params.responseFormat.schema,
        strict: true,
      },
    };
  }
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];

  const warnings: string[] = [];
  if (params.contextLength !== undefined) {
    warnings.push(
      `${target.provider} cannot set the context window per request; contextLength was ignored (configure it in the runtime).`,
    );
  }
  const applied = {
    contextLength: params.contextLength !== undefined ? false : undefined,
    responseFormat: params.responseFormat ? true : undefined,
  };
  const base = { provider: target.provider, host: target.host, local: target.local, model: params.model };

  const finish = (
    text: string,
    usage: { prompt?: number; completion?: number },
    timings: CompletionTimings,
    streamed: boolean,
  ): CompletionResult => {
    const structured = parseStructured(text, !!params.responseFormat);
    if (structured.warning) warnings.push(structured.warning);
    const usageEstimated = usage.completion === undefined;
    return {
      ...base,
      text,
      ...(structured.parsed !== undefined ? { parsed: structured.parsed } : {}),
      promptTokens: usage.prompt,
      completionTokens: usage.completion ?? (text ? estimateTokens(text) : 0),
      ...(usageEstimated ? { usageEstimated: true } : {}),
      totalDurationMs: Date.now() - start,
      streamed,
      ...(Object.keys(timings).length ? { timings } : {}),
      applied,
      ...(warnings.length ? { warnings } : {}),
    };
  };

  if (!opts.onChunk) {
    const data = await httpJson<OpenAiChatResponse>(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    const timings: CompletionTimings = {};
    if (data.timings?.prompt_ms !== undefined) timings.promptEvalMs = data.timings.prompt_ms;
    if (data.timings?.predicted_ms !== undefined) timings.evalMs = data.timings.predicted_ms;
    return finish(
      data.choices?.[0]?.message?.content ?? "",
      { prompt: data.usage?.prompt_tokens, completion: data.usage?.completion_tokens },
      timings,
      false,
    );
  }

  const onChunk = opts.onChunk;
  const run = async (includeUsage: boolean) => {
    let text = "";
    let prompt: number | undefined;
    let completion: number | undefined;
    const timings: CompletionTimings = {};
    await httpSse(
      target.url,
      {
        method: "POST",
        headers: target.headers,
        body: JSON.stringify({
          ...body,
          stream: true,
          ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
        }),
        timeoutMs: opts.timeoutMs,
        idleTimeoutMs: opts.idleTimeoutMs,
        signal: opts.signal,
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
          if (timings.ttftMs === undefined) timings.ttftMs = Date.now() - start;
          text += delta;
          await onChunk({ text: delta, done: false });
        }
        if (parsed.usage?.prompt_tokens !== undefined) prompt = parsed.usage.prompt_tokens;
        if (parsed.usage?.completion_tokens !== undefined) completion = parsed.usage.completion_tokens;
        if (parsed.timings?.prompt_ms !== undefined) timings.promptEvalMs = parsed.timings.prompt_ms;
        if (parsed.timings?.predicted_ms !== undefined) timings.evalMs = parsed.timings.predicted_ms;
      },
    );
    return { text, prompt, completion, timings };
  };

  let out;
  try {
    out = await run(true);
  } catch (err) {
    // Some servers reject unknown stream_options; retry once without it.
    if (err instanceof HttpError && err.status === 400 && /stream_options/i.test(err.body)) {
      out = await run(false);
    } else {
      throw err;
    }
  }
  await onChunk({ text: "", done: true });
  return finish(out.text, { prompt: out.prompt, completion: out.completion }, out.timings, true);
}
