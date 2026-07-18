import { httpJson, probe } from "../http.js";
import { openAiChatComplete } from "./openai-complete.js";
import type {
  CompletionChunkHandler,
  CompletionParams,
  CompletionResult,
  EmbedParams,
  EmbedResult,
  HealthStatus,
  LoadedModelInfo,
  ModelDetail,
  ModelSummary,
  Provider,
  ProviderCapabilities,
  PullResult,
} from "./types.js";

const PROVIDER = "ollama" as const;

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
  size_vram?: number;
  expires_at?: string;
  context_length?: number;
}

interface OpenAiEmbedResponse {
  data?: Array<{ embedding: number[] }>;
}

export class OllamaProvider implements Provider {
  readonly id = PROVIDER;
  readonly host: string;

  constructor(host: string) {
    this.host = host;
  }

  capabilities(): ProviderCapabilities {
    return {
      provider: PROVIDER,
      complete: true,
      embed: true,
      pull: true,
      remove: true,
      load: true,
      unload: true,
      search: false,
    };
  }

  async detect(timeoutMs: number): Promise<boolean> {
    return probe(`${this.host}/api/version`, timeoutMs);
  }

  async health(timeoutMs: number): Promise<HealthStatus> {
    try {
      const data = await httpJson<{ version?: string }>(`${this.host}/api/version`, { timeoutMs });
      return { provider: PROVIDER, live: true, host: this.host, version: data.version };
    } catch (err) {
      return {
        provider: PROVIDER,
        live: false,
        host: this.host,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listModels(timeoutMs: number): Promise<ModelSummary[]> {
    const data = await httpJson<{ models?: OllamaTagModel[] }>(`${this.host}/api/tags`, {
      timeoutMs,
    });
    return (data.models ?? []).map((m) => ({
      id: m.name,
      provider: PROVIDER,
      sizeBytes: m.size,
      family: m.details?.family,
      parameterSize: m.details?.parameter_size,
      quantization: m.details?.quantization_level,
      modifiedAt: m.modified_at,
    }));
  }

  async listLoaded(timeoutMs: number): Promise<LoadedModelInfo[]> {
    const data = await httpJson<{ models?: OllamaPsModel[] }>(`${this.host}/api/ps`, { timeoutMs });
    return (data.models ?? []).map((m) => ({
      id: m.name,
      provider: PROVIDER,
      sizeVramBytes: m.size_vram,
      expiresAt: m.expires_at,
      contextLength: m.context_length,
    }));
  }

  async modelInfo(model: string, timeoutMs: number): Promise<ModelDetail> {
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
      timeoutMs,
    });
    let contextLength: number | undefined;
    if (data.model_info) {
      for (const [key, value] of Object.entries(data.model_info)) {
        if (key.endsWith(".context_length") && typeof value === "number") {
          contextLength = value;
          break;
        }
      }
    }
    return {
      id: model,
      provider: PROVIDER,
      family: data.details?.family,
      parameterSize: data.details?.parameter_size,
      quantization: data.details?.quantization_level,
      contextLength,
      details: data.details,
    };
  }

  async pull(model: string, timeoutMs: number): Promise<PullResult> {
    const data = await httpJson<{ status?: string }>(`${this.host}/api/pull`, {
      method: "POST",
      body: JSON.stringify({ model, stream: false }),
      timeoutMs,
    });
    return { provider: PROVIDER, model, status: data.status ?? "success" };
  }

  async remove(
    model: string,
    timeoutMs: number,
  ): Promise<{ provider: typeof PROVIDER; model: string; removed: boolean }> {
    await httpJson(`${this.host}/api/delete`, {
      method: "DELETE",
      body: JSON.stringify({ model }),
      timeoutMs,
    });
    return { provider: PROVIDER, model, removed: true };
  }

  async load(
    model: string,
    timeoutMs: number,
    keepAlive?: string,
  ): Promise<{ provider: typeof PROVIDER; model: string; loaded: boolean; detail?: string }> {
    await httpJson(`${this.host}/api/generate`, {
      method: "POST",
      body: JSON.stringify({ model, prompt: "", keep_alive: keepAlive ?? "5m" }),
      timeoutMs,
    });
    return { provider: PROVIDER, model, loaded: true };
  }

  async unload(
    model: string,
    timeoutMs: number,
  ): Promise<{ provider: typeof PROVIDER; model: string; unloaded: boolean; detail?: string }> {
    await httpJson(`${this.host}/api/generate`, {
      method: "POST",
      body: JSON.stringify({ model, prompt: "", keep_alive: 0 }),
      timeoutMs,
    });
    return { provider: PROVIDER, model, unloaded: true };
  }

  async complete(
    params: CompletionParams,
    timeoutMs: number,
    onChunk?: CompletionChunkHandler,
  ): Promise<CompletionResult> {
    return openAiChatComplete(
      `${this.host}/v1/chat/completions`,
      PROVIDER,
      params,
      timeoutMs,
      { onChunk },
    );
  }

  async embed(params: EmbedParams, timeoutMs: number): Promise<EmbedResult> {
    const data = await httpJson<OpenAiEmbedResponse>(`${this.host}/v1/embeddings`, {
      method: "POST",
      body: JSON.stringify({ model: params.model, input: params.input }),
      timeoutMs,
    });
    const embeddings = (data.data ?? []).map((d) => d.embedding);
    return {
      provider: PROVIDER,
      model: params.model,
      embeddings,
      dimensions: embeddings[0]?.length ?? 0,
    };
  }
}
