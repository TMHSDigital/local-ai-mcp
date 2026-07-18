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

const PROVIDER = "openaicompat" as const;

interface OpenAiModel {
  id: string;
  owned_by?: string;
}

interface OpenAiEmbedResponse {
  data?: Array<{ embedding: number[] }>;
}

/**
 * Generic OpenAI-compatible local adapter. Opt-in via OPENAI_COMPAT_HOST
 * (e.g. vLLM, Jan, text-generation-webui, or any /v1 server).
 * Host should include the /v1 suffix when the server uses that layout.
 */
export class OpenAICompatProvider implements Provider {
  readonly id = PROVIDER;
  readonly host: string;
  private apiKey: string | undefined;

  constructor(host: string, apiKey?: string) {
    this.host = host;
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> | undefined {
    if (!this.apiKey) return undefined;
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  capabilities(): ProviderCapabilities {
    return {
      provider: PROVIDER,
      complete: true,
      embed: true,
      pull: false,
      remove: false,
      load: false,
      unload: false,
      search: false,
    };
  }

  async detect(timeoutMs: number): Promise<boolean> {
    try {
      await httpJson(`${this.host}/models`, {
        headers: this.headers(),
        timeoutMs,
      });
      return true;
    } catch {
      // Some servers only expose /v1/models under a bare host; also try health-ish probe
      return probe(`${this.host}/models`, timeoutMs);
    }
  }

  async health(timeoutMs: number): Promise<HealthStatus> {
    try {
      await httpJson(`${this.host}/models`, {
        headers: this.headers(),
        timeoutMs,
      });
      return { provider: PROVIDER, live: true, host: this.host };
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
    const data = await httpJson<{ data?: OpenAiModel[] }>(`${this.host}/models`, {
      headers: this.headers(),
      timeoutMs,
    });
    return (data.data ?? []).map((m) => ({
      id: m.id,
      provider: PROVIDER,
      family: m.owned_by,
    }));
  }

  async listLoaded(timeoutMs: number): Promise<LoadedModelInfo[]> {
    // Most OpenAI-compat local servers keep listed models ready; treat list as loaded.
    const models = await this.listModels(timeoutMs);
    return models.map((m) => ({ id: m.id, provider: PROVIDER }));
  }

  async modelInfo(model: string, timeoutMs: number): Promise<ModelDetail> {
    const models = await this.listModels(timeoutMs);
    const m = models.find((x) => x.id === model);
    if (!m) throw new Error(`Model not found on openaicompat: ${model}`);
    return { ...m };
  }

  async pull(_model: string, _timeoutMs: number): Promise<PullResult> {
    throw new Error("openaicompat does not support pull; load models in the upstream runtime");
  }

  async remove(
    _model: string,
    _timeoutMs: number,
  ): Promise<{ provider: typeof PROVIDER; model: string; removed: boolean }> {
    throw new Error("openaicompat does not support remove");
  }

  async load(
    _model: string,
    _timeoutMs: number,
    _keepAlive?: string,
  ): Promise<{ provider: typeof PROVIDER; model: string; loaded: boolean; detail?: string }> {
    throw new Error("openaicompat does not support load; models are managed by the upstream server");
  }

  async unload(
    _model: string,
    _timeoutMs: number,
  ): Promise<{ provider: typeof PROVIDER; model: string; unloaded: boolean; detail?: string }> {
    throw new Error("openaicompat does not support unload");
  }

  async complete(
    params: CompletionParams,
    timeoutMs: number,
    onChunk?: CompletionChunkHandler,
  ): Promise<CompletionResult> {
    return openAiChatComplete(
      `${this.host}/chat/completions`,
      PROVIDER,
      params,
      timeoutMs,
      { headers: this.headers(), onChunk },
    );
  }

  async embed(params: EmbedParams, timeoutMs: number): Promise<EmbedResult> {
    const data = await httpJson<OpenAiEmbedResponse>(`${this.host}/embeddings`, {
      method: "POST",
      headers: this.headers(),
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
