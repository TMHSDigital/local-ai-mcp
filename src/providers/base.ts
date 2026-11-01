import { inferKind } from "../config.js";
import { httpJson, probe } from "../http.js";
import { openAiChatComplete } from "./openai-complete.js";
import {
  ModelNotFoundError,
  UnsupportedOperationError,
  type CompletionChunkHandler,
  type CompletionParams,
  type CompletionResult,
  type EmbedParams,
  type EmbedResult,
  type HealthStatus,
  type LifecycleResult,
  type LoadedModelInfo,
  type ModelDetail,
  type ModelSummary,
  type Provider,
  type ProviderCapabilities,
  type ProviderId,
  type ProviderKind,
  type PullProgressHandler,
  type PullResult,
  type RequestOptions,
} from "./types.js";

export interface ProviderOptions {
  /** Instance name (defaults to the adapter type). */
  name?: string;
  apiKey?: string;
  /** Overrides host-based local/hosted inference. */
  kind?: ProviderKind;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Shared plumbing for every adapter: identity, auth headers, capability
 * shape, and "unsupported" defaults for lifecycle operations.
 */
export abstract class BaseProvider implements Provider {
  abstract readonly type: ProviderId;
  readonly host: string;
  readonly kind: ProviderKind;
  protected readonly apiKey: string | undefined;
  private readonly instanceName: string | undefined;

  constructor(host: string, opts: ProviderOptions = {}) {
    this.host = host;
    this.apiKey = opts.apiKey;
    this.kind = opts.kind ?? inferKind(host);
    this.instanceName = opts.name;
  }

  get name(): string {
    return this.instanceName ?? this.type;
  }

  protected authHeaders(): Record<string, string> | undefined {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined;
  }

  protected caps(partial: Partial<Omit<ProviderCapabilities, "provider" | "type" | "kind">>): ProviderCapabilities {
    return {
      provider: this.name,
      type: this.type,
      kind: this.kind,
      complete: false,
      embed: false,
      pull: false,
      remove: false,
      load: false,
      unload: false,
      contextLength: false,
      structuredOutput: false,
      ...partial,
    };
  }

  protected healthy(version?: string): HealthStatus {
    return {
      provider: this.name,
      type: this.type,
      kind: this.kind,
      live: true,
      host: this.host,
      ...(version ? { version } : {}),
    };
  }

  protected unhealthy(err: unknown): HealthStatus {
    return {
      provider: this.name,
      type: this.type,
      kind: this.kind,
      live: false,
      host: this.host,
      error: errorMessage(err),
    };
  }

  protected unsupported(op: string, hint?: string): never {
    throw new UnsupportedOperationError(this.name, op, hint);
  }

  abstract capabilities(): ProviderCapabilities;
  abstract detect(opts: RequestOptions): Promise<boolean>;
  abstract health(opts: RequestOptions): Promise<HealthStatus>;
  abstract listModels(opts: RequestOptions): Promise<ModelSummary[]>;
  abstract listLoaded(opts: RequestOptions): Promise<LoadedModelInfo[]>;
  abstract modelInfo(model: string, opts: RequestOptions): Promise<ModelDetail>;
  abstract complete(
    params: CompletionParams,
    opts: RequestOptions & { onChunk?: CompletionChunkHandler; idleTimeoutMs?: number },
  ): Promise<CompletionResult>;
  abstract embed(params: EmbedParams, opts: RequestOptions): Promise<EmbedResult>;

  async pull(
    _model: string,
    _opts: RequestOptions & { onProgress?: PullProgressHandler },
  ): Promise<PullResult> {
    this.unsupported("pull", "download models with the runtime's own tooling");
  }

  async remove(_model: string, _opts: RequestOptions): Promise<LifecycleResult & { removed: boolean }> {
    this.unsupported("remove");
  }

  async load(
    _model: string,
    _opts: RequestOptions & { keepAlive?: string; contextLength?: number },
  ): Promise<LifecycleResult & { loaded: boolean }> {
    this.unsupported("load", "models are managed by the runtime");
  }

  async unload(_model: string, _opts: RequestOptions): Promise<LifecycleResult & { unloaded: boolean }> {
    this.unsupported("unload", "models are managed by the runtime");
  }
}

interface OpenAiModel {
  id: string;
  owned_by?: string;
  max_model_len?: number;
  context_length?: number;
}

interface OpenAiEmbedResponse {
  data?: Array<{ embedding: number[]; index?: number }>;
}

/** Normalise an embedding response and enforce one vector per input. */
export function toEmbedResult(
  provider: BaseProvider,
  params: EmbedParams,
  embeddings: number[][],
): EmbedResult {
  const expected = Array.isArray(params.input) ? params.input.length : 1;
  if (embeddings.length !== expected) {
    throw new Error(
      `${provider.name} returned ${embeddings.length} embedding(s) for ${expected} input(s)`,
    );
  }
  return {
    provider: provider.name,
    host: provider.host,
    local: provider.kind === "local",
    model: params.model,
    embeddings,
    dimensions: embeddings[0]?.length ?? 0,
  };
}

/**
 * Adapter for servers that speak the OpenAI REST shape. `v1()` is the base
 * that /models, /chat/completions and /embeddings hang off.
 */
export abstract class OpenAICompatibleProvider extends BaseProvider {
  /** OpenAI-style API base. Defaults to the configured host as-is. */
  protected v1(): string {
    return this.host;
  }

  capabilities(): ProviderCapabilities {
    return this.caps({ complete: true, embed: true, structuredOutput: true });
  }

  async detect(opts: RequestOptions): Promise<boolean> {
    return probe(`${this.v1()}/models`, opts.timeoutMs, {
      headers: this.authHeaders(),
      signal: opts.signal,
    });
  }

  async health(opts: RequestOptions): Promise<HealthStatus> {
    try {
      await httpJson(`${this.v1()}/models`, { headers: this.authHeaders(), ...opts });
      return this.healthy();
    } catch (err) {
      return this.unhealthy(err);
    }
  }

  protected mapModel(m: OpenAiModel): ModelSummary {
    const ctx = m.max_model_len ?? m.context_length;
    return {
      id: m.id,
      provider: this.name,
      ...(m.owned_by ? { family: m.owned_by } : {}),
      ...(ctx ? { contextLength: ctx } : {}),
    };
  }

  async listModels(opts: RequestOptions): Promise<ModelSummary[]> {
    const data = await httpJson<{ data?: OpenAiModel[] }>(`${this.v1()}/models`, {
      headers: this.authHeaders(),
      ...opts,
    });
    return (data.data ?? []).map((m) => this.mapModel(m));
  }

  /** Most OpenAI-style servers only list models they are serving. */
  async listLoaded(opts: RequestOptions): Promise<LoadedModelInfo[]> {
    const models = await this.listModels(opts);
    return models.map((m) => ({
      id: m.id,
      provider: this.name,
      ...(m.contextLength ? { contextLength: m.contextLength } : {}),
    }));
  }

  async modelInfo(model: string, opts: RequestOptions): Promise<ModelDetail> {
    const models = await this.listModels(opts);
    const m = models.find((x) => x.id === model);
    if (!m) throw new ModelNotFoundError(this.name, model);
    return { ...m };
  }

  async complete(
    params: CompletionParams,
    opts: RequestOptions & { onChunk?: CompletionChunkHandler; idleTimeoutMs?: number },
  ): Promise<CompletionResult> {
    return openAiChatComplete(
      {
        url: `${this.v1()}/chat/completions`,
        provider: this.name,
        host: this.host,
        local: this.kind === "local",
        headers: this.authHeaders(),
      },
      params,
      opts,
    );
  }

  async embed(params: EmbedParams, opts: RequestOptions): Promise<EmbedResult> {
    const data = await httpJson<OpenAiEmbedResponse>(`${this.v1()}/embeddings`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ model: params.model, input: params.input }),
      ...opts,
    });
    const rows = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return toEmbedResult(this, params, rows.map((d) => d.embedding));
  }
}
