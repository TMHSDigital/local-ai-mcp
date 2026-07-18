import { httpJson } from "../http.js";
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

const PROVIDER = "moonshot" as const;

interface MoonshotModel {
  id: string;
  owned_by?: string;
  context_length?: number;
}

// Hosted API (https://api.moonshot.ai/v1): models are managed by Moonshot, so
// there is no pull/remove/load/unload lifecycle. The host is expected to
// include the /v1 path segment.
export class MoonshotProvider implements Provider {
  readonly id = PROVIDER;
  readonly host: string;
  private apiKey: string | undefined;

  constructor(host: string, apiKey?: string) {
    this.host = host;
    this.apiKey = apiKey;
  }

  private authHeaders(): Record<string, string> {
    if (!this.apiKey) {
      throw new Error(
        "MOONSHOT_API_KEY is not set; set it to use the moonshot provider",
      );
    }
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  capabilities(): ProviderCapabilities {
    return {
      provider: PROVIDER,
      complete: true,
      embed: false,
      pull: false,
      remove: false,
      load: false,
      unload: false,
      search: false,
    };
  }

  async detect(timeoutMs: number): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      await httpJson(`${this.host}/models`, {
        headers: this.authHeaders(),
        timeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  }

  async health(timeoutMs: number): Promise<HealthStatus> {
    try {
      await httpJson(`${this.host}/models`, {
        headers: this.authHeaders(),
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
    const data = await httpJson<{ data?: MoonshotModel[] }>(`${this.host}/models`, {
      headers: this.authHeaders(),
      timeoutMs,
    });
    return (data.data ?? []).map((m) => ({
      id: m.id,
      provider: PROVIDER,
      family: m.owned_by,
    }));
  }

  async listLoaded(_timeoutMs: number): Promise<LoadedModelInfo[]> {
    // Hosted API: models are always available server-side; nothing is "loaded" locally.
    return [];
  }

  async modelInfo(model: string, timeoutMs: number): Promise<ModelDetail> {
    const data = await httpJson<{ data?: MoonshotModel[] }>(`${this.host}/models`, {
      headers: this.authHeaders(),
      timeoutMs,
    });
    const m = (data.data ?? []).find((x) => x.id === model);
    if (!m) {
      throw new Error(`Model not found on moonshot: ${model}`);
    }
    return {
      id: m.id,
      provider: PROVIDER,
      family: m.owned_by,
      contextLength: m.context_length,
      details: m as unknown as Record<string, unknown>,
    };
  }

  async pull(_model: string, _timeoutMs: number): Promise<PullResult> {
    throw new Error("moonshot is a hosted API; models cannot be pulled");
  }

  async remove(
    _model: string,
    _timeoutMs: number,
  ): Promise<{ provider: typeof PROVIDER; model: string; removed: boolean }> {
    throw new Error("moonshot is a hosted API; models cannot be removed");
  }

  async load(
    _model: string,
    _timeoutMs: number,
    _keepAlive?: string,
  ): Promise<{ provider: typeof PROVIDER; model: string; loaded: boolean; detail?: string }> {
    throw new Error("moonshot is a hosted API; models cannot be loaded");
  }

  async unload(
    _model: string,
    _timeoutMs: number,
  ): Promise<{ provider: typeof PROVIDER; model: string; unloaded: boolean; detail?: string }> {
    throw new Error("moonshot is a hosted API; models cannot be unloaded");
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
      { headers: this.authHeaders(), onChunk },
    );
  }

  async embed(_params: EmbedParams, _timeoutMs: number): Promise<EmbedResult> {
    throw new Error("moonshot does not expose an embeddings endpoint");
  }
}
