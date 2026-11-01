import { httpJson, probe } from "../http.js";
import { OpenAICompatibleProvider, errorMessage, toEmbedResult } from "./base.js";
import {
  ModelNotFoundError,
  type EmbedParams,
  type EmbedResult,
  type HealthStatus,
  type LoadedModelInfo,
  type ModelDetail,
  type ModelSummary,
  type ProviderCapabilities,
  type RequestOptions,
} from "./types.js";

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

/**
 * First-class llama.cpp server adapter (llama-server).
 * Uses native /health, /props, /slots plus OpenAI-compatible /v1 routes.
 */
export class LlamaCppProvider extends OpenAICompatibleProvider {
  readonly type = "llamacpp" as const;

  /** Base without trailing /v1: native routes live on the server root. */
  private root(): string {
    return this.host.replace(/\/v1\/?$/i, "");
  }

  protected override v1(): string {
    return `${this.root()}/v1`;
  }

  override capabilities(): ProviderCapabilities {
    return this.caps({ complete: true, embed: true, structuredOutput: true });
  }

  override async detect(opts: RequestOptions): Promise<boolean> {
    if (await probe(`${this.root()}/health`, opts.timeoutMs, { signal: opts.signal })) return true;
    return super.detect(opts);
  }

  override async health(opts: RequestOptions): Promise<HealthStatus> {
    try {
      const data = await httpJson<{ status?: string }>(`${this.root()}/health`, opts);
      return this.healthy(data.status ?? "ok");
    } catch (err) {
      // Fall back to /v1/models for servers without /health
      const fallback = await super.health(opts);
      return fallback.live ? fallback : this.unhealthy(err);
    }
  }

  private async props(opts: RequestOptions): Promise<LlamaCppProps | undefined> {
    try {
      return await httpJson<LlamaCppProps>(`${this.root()}/props`, opts);
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

  override async listModels(opts: RequestOptions): Promise<ModelSummary[]> {
    try {
      const models = await super.listModels(opts);
      if (models.length > 0) return models;
    } catch {
      // fall through to /props
    }
    const props = await this.props(opts);
    const id = this.modelIdFromProps(props);
    if (!id) return [];
    const ctx = props?.default_generation_settings?.n_ctx;
    return [{ id, provider: this.name, ...(ctx ? { contextLength: ctx } : {}) }];
  }

  override async listLoaded(opts: RequestOptions): Promise<LoadedModelInfo[]> {
    try {
      const slots = await httpJson<LlamaCppSlot[]>(`${this.root()}/slots`, opts);
      if (Array.isArray(slots) && slots.length > 0) {
        const byId = new Map<string, LoadedModelInfo>();
        for (const slot of slots) {
          const id = slot.model || slot.params?.model;
          if (!id) continue;
          byId.set(id, { id, provider: this.name, contextLength: slot.n_ctx });
        }
        if (byId.size > 0) return [...byId.values()];
      }
    } catch {
      // slots endpoint optional
    }
    const props = await this.props(opts);
    const id = this.modelIdFromProps(props);
    if (!id) return [];
    return [{ id, provider: this.name, contextLength: props?.default_generation_settings?.n_ctx }];
  }

  override async modelInfo(model: string, opts: RequestOptions): Promise<ModelDetail> {
    const [props, models] = await Promise.all([this.props(opts), this.listModels(opts)]);
    const m = models.find((x) => x.id === model);
    if (!m) throw new ModelNotFoundError(this.name, model);
    return {
      ...m,
      contextLength: props?.default_generation_settings?.n_ctx ?? m.contextLength,
      details: props as unknown as Record<string, unknown>,
    };
  }

  /**
   * OpenAI /v1/embeddings first; native /embedding as a fallback for older
   * servers. The fallback embeds every input (one request each) so the
   * result always has one vector per input.
   */
  override async embed(params: EmbedParams, opts: RequestOptions): Promise<EmbedResult> {
    let v1Error: unknown;
    try {
      return await super.embed(params, opts);
    } catch (err) {
      v1Error = err;
    }
    const inputs = Array.isArray(params.input) ? params.input : [params.input];
    try {
      const embeddings: number[][] = [];
      for (const content of inputs) {
        const data = await httpJson<{ embedding?: number[] | number[][] } | Array<{ embedding?: number[] | number[][] }>>(
          `${this.root()}/embedding`,
          { method: "POST", body: JSON.stringify({ content }), ...opts },
        );
        const row = Array.isArray(data) ? data[0]?.embedding : data.embedding;
        // Newer servers nest per-token vectors; take the pooled first row.
        const vec = Array.isArray(row?.[0]) ? (row as number[][])[0] : (row as number[] | undefined);
        if (!vec || vec.length === 0) throw new Error("empty embedding");
        embeddings.push(vec);
      }
      return toEmbedResult(this, params, embeddings);
    } catch (err) {
      throw new Error(
        `llama.cpp embeddings failed (/v1/embeddings: ${errorMessage(v1Error)}; /embedding: ${errorMessage(err)}). Start llama-server with --embeddings and an embedding model.`,
      );
    }
  }
}
