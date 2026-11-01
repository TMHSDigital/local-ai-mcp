import { httpJson, httpNdjson, probe } from "../http.js";
import { BaseProvider, toEmbedResult } from "./base.js";
import { buildMessages, estimateTokens, parseStructured } from "./openai-complete.js";
import type {
  CompletionChunkHandler,
  CompletionParams,
  CompletionResult,
  CompletionTimings,
  ContentPart,
  EmbedParams,
  EmbedResult,
  HealthStatus,
  LifecycleResult,
  LoadedModelInfo,
  ModelArchitecture,
  ModelDetail,
  ModelSummary,
  ProviderCapabilities,
  PullProgressHandler,
  PullResult,
  RequestOptions,
} from "./types.js";

interface OllamaTagModel {
  name: string;
  size?: number;
  modified_at?: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface OllamaPsModel {
  name: string;
  size?: number;
  size_vram?: number;
  expires_at?: string;
  context_length?: number;
}

interface OllamaChatChunk {
  message?: { content?: string };
  done?: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

const NS_PER_MS = 1e6;

/** Pull layer architecture out of /api/show `model_info` (GGUF metadata keys). */
export function parseOllamaArchitecture(
  modelInfo: Record<string, unknown> | undefined,
): { architecture?: ModelArchitecture; contextLength?: number; parameterCount?: number } {
  if (!modelInfo) return {};
  const arch = typeof modelInfo["general.architecture"] === "string"
    ? (modelInfo["general.architecture"] as string)
    : undefined;
  const num = (key: string): number | undefined => {
    const v = modelInfo[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  let contextLength: number | undefined;
  if (arch) contextLength = num(`${arch}.context_length`);
  if (contextLength === undefined) {
    for (const [k, v] of Object.entries(modelInfo)) {
      if (k.endsWith(".context_length") && typeof v === "number") {
        contextLength = v;
        break;
      }
    }
  }
  const parameterCount = num("general.parameter_count");
  if (!arch) return { contextLength, parameterCount };

  const layers = num(`${arch}.block_count`);
  const headCount = num(`${arch}.attention.head_count`);
  const embedding = num(`${arch}.embedding_length`);
  const rawKv = modelInfo[`${arch}.attention.head_count_kv`];
  let kvHeads: number | undefined;
  if (typeof rawKv === "number") kvHeads = rawKv;
  else if (Array.isArray(rawKv) && rawKv.length > 0 && rawKv.every((x) => typeof x === "number")) {
    // Per-layer KV head counts (e.g. hybrid models): use the average.
    kvHeads = (rawKv as number[]).reduce((a, b) => a + b, 0) / rawKv.length;
  } else {
    kvHeads = headCount;
  }
  const headDim = headCount && embedding ? embedding / headCount : undefined;
  const keyLength = num(`${arch}.attention.key_length`) ?? headDim;
  const valueLength = num(`${arch}.attention.value_length`) ?? keyLength;
  if (layers && kvHeads && keyLength && valueLength) {
    return {
      architecture: { layers, kvHeads, keyLength, valueLength },
      contextLength,
      parameterCount,
    };
  }
  return { contextLength, parameterCount };
}

function formatParameterCount(n: number | undefined): string | undefined {
  if (!n) return undefined;
  return n >= 1e9 ? `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B` : `${Math.round(n / 1e6)}M`;
}

async function imageToBase64(part: Extract<ContentPart, { type: "image" }>, opts: RequestOptions): Promise<string> {
  if (part.data) return part.data;
  if (!part.url) throw new Error("image content part needs data or url");
  const dataUrl = part.url.match(/^data:[^;]+;base64,(.*)$/);
  if (dataUrl) return dataUrl[1];
  const res = await fetch(part.url, { signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs) });
  if (!res.ok) throw new Error(`Failed to fetch image ${part.url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

/**
 * Ollama adapter on the native API. Native /api/chat is used instead of the
 * OpenAI-compatible /v1 route because only the native route accepts
 * options.num_ctx (context window) and returns exact timing metrics.
 */
export class OllamaProvider extends BaseProvider {
  readonly type = "ollama" as const;

  capabilities(): ProviderCapabilities {
    return this.caps({
      complete: true,
      embed: true,
      pull: true,
      remove: true,
      load: true,
      unload: true,
      contextLength: true,
      structuredOutput: true,
    });
  }

  async detect(opts: RequestOptions): Promise<boolean> {
    return probe(`${this.host}/api/version`, opts.timeoutMs, { signal: opts.signal });
  }

  async health(opts: RequestOptions): Promise<HealthStatus> {
    try {
      const data = await httpJson<{ version?: string }>(`${this.host}/api/version`, opts);
      return this.healthy(data.version);
    } catch (err) {
      return this.unhealthy(err);
    }
  }

  async listModels(opts: RequestOptions): Promise<ModelSummary[]> {
    const data = await httpJson<{ models?: OllamaTagModel[] }>(`${this.host}/api/tags`, opts);
    return (data.models ?? []).map((m) => ({
      id: m.name,
      provider: this.name,
      sizeBytes: m.size,
      family: m.details?.family,
      parameterSize: m.details?.parameter_size,
      quantization: m.details?.quantization_level,
      modifiedAt: m.modified_at,
    }));
  }

  async listLoaded(opts: RequestOptions): Promise<LoadedModelInfo[]> {
    const data = await httpJson<{ models?: OllamaPsModel[] }>(`${this.host}/api/ps`, opts);
    return (data.models ?? []).map((m) => ({
      id: m.name,
      provider: this.name,
      sizeBytes: m.size,
      sizeVramBytes: m.size_vram,
      expiresAt: m.expires_at,
      contextLength: m.context_length,
    }));
  }

  async modelInfo(model: string, opts: RequestOptions): Promise<ModelDetail> {
    const data = await httpJson<{
      details?: {
        family?: string;
        parameter_size?: string;
        quantization_level?: string;
      };
      model_info?: Record<string, unknown>;
    }>(`${this.host}/api/show`, {
      method: "POST",
      body: JSON.stringify({ model }),
      ...opts,
    });
    const parsed = parseOllamaArchitecture(data.model_info);
    return {
      id: model,
      provider: this.name,
      family: data.details?.family,
      parameterSize: data.details?.parameter_size ?? formatParameterCount(parsed.parameterCount),
      quantization: data.details?.quantization_level,
      contextLength: parsed.contextLength,
      ...(parsed.architecture ? { architecture: parsed.architecture } : {}),
      details: data.details,
    };
  }

  async pull(
    model: string,
    opts: RequestOptions & { onProgress?: PullProgressHandler },
  ): Promise<PullResult> {
    let last = "success";
    await httpNdjson<{ status?: string; total?: number; completed?: number }>(
      `${this.host}/api/pull`,
      {
        method: "POST",
        body: JSON.stringify({ model, stream: true }),
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      },
      async (evt) => {
        if (evt.status) last = evt.status;
        await opts.onProgress?.({
          status: evt.status ?? "pulling",
          ...(evt.completed !== undefined ? { completed: evt.completed } : {}),
          ...(evt.total !== undefined ? { total: evt.total } : {}),
        });
      },
    );
    return { provider: this.name, model, status: last };
  }

  async remove(model: string, opts: RequestOptions): Promise<LifecycleResult & { removed: boolean }> {
    await httpJson(`${this.host}/api/delete`, {
      method: "DELETE",
      body: JSON.stringify({ model }),
      ...opts,
    });
    return { provider: this.name, model, removed: true };
  }

  async load(
    model: string,
    opts: RequestOptions & { keepAlive?: string; contextLength?: number },
  ): Promise<LifecycleResult & { loaded: boolean }> {
    await httpJson(`${this.host}/api/generate`, {
      method: "POST",
      body: JSON.stringify({
        model,
        keep_alive: opts.keepAlive ?? "5m",
        ...(opts.contextLength ? { options: { num_ctx: opts.contextLength } } : {}),
      }),
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    return { provider: this.name, model, loaded: true };
  }

  async unload(model: string, opts: RequestOptions): Promise<LifecycleResult & { unloaded: boolean }> {
    await httpJson(`${this.host}/api/generate`, {
      method: "POST",
      body: JSON.stringify({ model, keep_alive: 0 }),
      ...opts,
    });
    return { provider: this.name, model, unloaded: true };
  }

  async complete(
    params: CompletionParams,
    opts: RequestOptions & { onChunk?: CompletionChunkHandler; idleTimeoutMs?: number },
  ): Promise<CompletionResult> {
    const start = Date.now();
    const messages = await Promise.all(
      buildMessages(params).map(async (m) => {
        if (typeof m.content === "string") return { role: m.role, content: m.content };
        const text = m.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        const images = await Promise.all(
          m.content
            .filter((p): p is Extract<ContentPart, { type: "image" }> => p.type === "image")
            .map((p) => imageToBase64(p, opts)),
        );
        return { role: m.role, content: text, ...(images.length ? { images } : {}) };
      }),
    );
    const options: Record<string, unknown> = {
      num_ctx: params.contextLength,
      num_predict: params.maxTokens,
      temperature: params.temperature,
      top_p: params.topP,
      top_k: params.topK,
      seed: params.seed,
      repeat_penalty: params.repeatPenalty,
      stop: params.stop,
      ...(params.options ?? {}),
    };
    for (const k of Object.keys(options)) if (options[k] === undefined) delete options[k];
    const format =
      params.responseFormat?.type === "json_schema"
        ? params.responseFormat.schema
        : params.responseFormat?.type === "json_object"
          ? "json"
          : undefined;
    const body = {
      model: params.model,
      messages,
      ...(Object.keys(options).length ? { options } : {}),
      ...(format !== undefined ? { format } : {}),
    };

    let text = "";
    let final: OllamaChatChunk = {};
    let ttftMs: number | undefined;
    const streamed = !!opts.onChunk;
    if (opts.onChunk) {
      const onChunk = opts.onChunk;
      await httpNdjson<OllamaChatChunk>(
        `${this.host}/api/chat`,
        {
          method: "POST",
          body: JSON.stringify({ ...body, stream: true }),
          timeoutMs: opts.timeoutMs,
          idleTimeoutMs: opts.idleTimeoutMs,
          signal: opts.signal,
        },
        async (chunk) => {
          const delta = chunk.message?.content ?? "";
          if (delta) {
            if (ttftMs === undefined) ttftMs = Date.now() - start;
            text += delta;
            await onChunk({ text: delta, done: false });
          }
          if (chunk.done) final = chunk;
        },
      );
      await onChunk({ text: "", done: true });
    } else {
      final = await httpJson<OllamaChatChunk>(`${this.host}/api/chat`, {
        method: "POST",
        body: JSON.stringify({ ...body, stream: false }),
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      });
      text = final.message?.content ?? "";
    }

    const timings: CompletionTimings = {};
    if (final.load_duration !== undefined) timings.loadMs = final.load_duration / NS_PER_MS;
    if (ttftMs !== undefined) timings.ttftMs = ttftMs;
    if (final.prompt_eval_duration !== undefined) timings.promptEvalMs = final.prompt_eval_duration / NS_PER_MS;
    if (final.eval_duration !== undefined) timings.evalMs = final.eval_duration / NS_PER_MS;

    const warnings: string[] = [];
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    const estimatedPromptTokens = Math.round(promptChars / 4);
    const seen = final.prompt_eval_count;
    if (seen !== undefined) {
      if (params.contextLength && seen >= params.contextLength * 0.98) {
        warnings.push(
          `Prompt filled the ${params.contextLength}-token context window; input was likely truncated. Pass a larger contextLength.`,
        );
      } else if (!params.contextLength && estimatedPromptTokens > seen * 1.5 && seen > 256) {
        warnings.push(
          `Prompt likely truncated: ~${estimatedPromptTokens} tokens sent but the model evaluated ${seen}. Pass contextLength to raise Ollama's num_ctx.`,
        );
      }
    }
    const structured = parseStructured(text, !!params.responseFormat);
    if (structured.warning) warnings.push(structured.warning);

    return {
      provider: this.name,
      host: this.host,
      local: this.kind === "local",
      model: params.model,
      text,
      ...(structured.parsed !== undefined ? { parsed: structured.parsed } : {}),
      promptTokens: final.prompt_eval_count,
      completionTokens: final.eval_count ?? (text ? estimateTokens(text) : 0),
      ...(final.eval_count === undefined ? { usageEstimated: true } : {}),
      totalDurationMs: Date.now() - start,
      streamed,
      ...(Object.keys(timings).length ? { timings } : {}),
      applied: {
        ...(params.contextLength !== undefined ? { contextLength: true } : {}),
        ...(params.responseFormat ? { responseFormat: true } : {}),
      },
      ...(warnings.length ? { warnings } : {}),
    };
  }

  async embed(params: EmbedParams, opts: RequestOptions): Promise<EmbedResult> {
    const data = await httpJson<{ embeddings?: number[][] }>(`${this.host}/api/embed`, {
      method: "POST",
      body: JSON.stringify({ model: params.model, input: params.input }),
      ...opts,
    });
    return toEmbedResult(this, params, data.embeddings ?? []);
  }
}
