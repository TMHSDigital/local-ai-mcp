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

const PROVIDER = "llamacpp" as const;

interface LlamaCppProps {
  model_path?: string;
  model_alias?: string;
  default_generation_settings?: {
    n_ctx?: number;
    model?: string;
  };
  total_slots?: number;
}

interface LlamaCppSlot {
  id?: number;
  is_processing?: boolean;
  n_ctx?: number;
  model?: string;
  params?: { model?: string };
}

interface OpenAiModel {
  id: string;
  owned_by?: string;
}

interface OpenAiEmbedResponse {
  data?: Array<{ embedding: number[] }>;
  embedding?: number[];
}

/**
 * First-class llama.cpp server adapter (llama-server).
 * Uses native /health, /props, /slots plus OpenAI-compatible /v1 routes.
 */
export class LlamaCppProvider implements Provider {
  readonly id = PROVIDER;
  readonly host: string;

  constructor(host: string) {
    this.host = host;
  }

  /** Base without trailing /v1 — native routes live on the server root. */
  private root(): string {
    return this.host.replace(/\/v1\/?$/i, "");
  }

  private v1(): string {
    const root = this.root();
    return this.host.toLowerCase().endsWith("/v1") ? this.host : `${root}/v1`;
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
    if (await probe(`${this.root()}/health`, timeoutMs)) return true;
    try {
      await httpJson(`${this.v1()}/models`, { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  async health(timeoutMs: number): Promise<HealthStatus> {
    try {
      const data = await httpJson<{ status?: string }>(`${this.root()}/health`, { timeoutMs });
      return {
        provider: PROVIDER,
        live: true,
        host: this.host,
        version: data.status ?? "ok",
      };
    } catch (err) {
      // Fall back to /v1/models for servers without /health
      try {
        await httpJson(`${this.v1()}/models`, { timeoutMs });
        return { provider: PROVIDER, live: true, host: this.host };
      } catch {
        return {
          provider: PROVIDER,
          live: false,
          host: this.host,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  private async props(timeoutMs: number): Promise<LlamaCppProps | undefined> {
    try {
      return await httpJson<LlamaCppProps>(`${this.root()}/props`, { timeoutMs });
    } catch {
      return undefined;
    }
  }

  private modelIdFromProps(props: LlamaCppProps | undefined): string | undefined {
    if (!props) return undefined;
    return (
      props.model_alias ||
      props.default_generation_settings?.model ||
      (props.model_path ? props.model_path.split(/[/\\]/).pop() : undefined)
    );
  }

  async listModels(timeoutMs: number): Promise<ModelSummary[]> {
    try {
      const data = await httpJson<{ data?: OpenAiModel[] }>(`${this.v1()}/models`, { timeoutMs });
      if (data.data && data.data.length > 0) {
        return data.data.map((m) => ({
          id: m.id,
          provider: PROVIDER,
          family: m.owned_by,
        }));
      }
    } catch {
      // fall through to /props
    }
    const props = await this.props(timeoutMs);
    const id = this.modelIdFromProps(props);
    if (!id) return [];
    return [{ id, provider: PROVIDER }];
  }

  async listLoaded(timeoutMs: number): Promise<LoadedModelInfo[]> {
    try {
      const slots = await httpJson<LlamaCppSlot[]>(`${this.root()}/slots`, { timeoutMs });
      if (Array.isArray(slots) && slots.length > 0) {
        const byId = new Map<string, LoadedModelInfo>();
        for (const slot of slots) {
          const id = slot.model || slot.params?.model;
          if (!id) continue;
          byId.set(id, {
            id,
            provider: PROVIDER,
            contextLength: slot.n_ctx,
          });
        }
        if (byId.size > 0) return [...byId.values()];
      }
    } catch {
      // slots endpoint optional
    }
    const props = await this.props(timeoutMs);
    const id = this.modelIdFromProps(props);
    if (!id) return [];
    return [
      {
        id,
        provider: PROVIDER,
        contextLength: props?.default_generation_settings?.n_ctx,
      },
    ];
  }

  async modelInfo(model: string, timeoutMs: number): Promise<ModelDetail> {
    const props = await this.props(timeoutMs);
    const models = await this.listModels(timeoutMs);
    const m = models.find((x) => x.id === model);
    if (!m) throw new Error(`Model not found on llamacpp: ${model}`);
    return {
      ...m,
      contextLength: props?.default_generation_settings?.n_ctx,
      details: props as unknown as Record<string, unknown>,
    };
  }

  async pull(_model: string, _timeoutMs: number): Promise<PullResult> {
    throw new Error("llamacpp does not support pull; start llama-server with --model");
  }

  async remove(
    _model: string,
    _timeoutMs: number,
  ): Promise<{ provider: typeof PROVIDER; model: string; removed: boolean }> {
    throw new Error("llamacpp does not support remove");
  }

  async load(
    _model: string,
    _timeoutMs: number,
    _keepAlive?: string,
  ): Promise<{ provider: typeof PROVIDER; model: string; loaded: boolean; detail?: string }> {
    throw new Error("llamacpp loads the model at server start; restart llama-server to change models");
  }

  async unload(
    _model: string,
    _timeoutMs: number,
  ): Promise<{ provider: typeof PROVIDER; model: string; unloaded: boolean; detail?: string }> {
    throw new Error("llamacpp does not support unload; stop the server to free VRAM");
  }

  async complete(
    params: CompletionParams,
    timeoutMs: number,
    onChunk?: CompletionChunkHandler,
  ): Promise<CompletionResult> {
    return openAiChatComplete(
      `${this.v1()}/chat/completions`,
      PROVIDER,
      params,
      timeoutMs,
      { onChunk },
    );
  }

  async embed(params: EmbedParams, timeoutMs: number): Promise<EmbedResult> {
    try {
      const data = await httpJson<OpenAiEmbedResponse>(`${this.v1()}/embeddings`, {
        method: "POST",
        body: JSON.stringify({ model: params.model, input: params.input }),
        timeoutMs,
      });
      const embeddings = (data.data ?? []).map((d) => d.embedding);
      if (embeddings.length > 0) {
        return {
          provider: PROVIDER,
          model: params.model,
          embeddings,
          dimensions: embeddings[0]?.length ?? 0,
        };
      }
    } catch {
      // fall through to native /embedding
    }
    const input = Array.isArray(params.input) ? params.input[0] : params.input;
    const data = await httpJson<{ embedding?: number[] }>(`${this.root()}/embedding`, {
      method: "POST",
      body: JSON.stringify({ content: input }),
      timeoutMs,
    });
    const embedding = data.embedding ?? [];
    return {
      provider: PROVIDER,
      model: params.model,
      embeddings: [embedding],
      dimensions: embedding.length,
    };
  }
}
