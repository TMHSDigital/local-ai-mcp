import { httpJson, probe } from "../http.js";
import { OpenAICompatibleProvider } from "./base.js";
import type {
  EmbedParams,
  EmbedResult,
  HealthStatus,
  LifecycleResult,
  LoadedModelInfo,
  ProviderCapabilities,
  RequestOptions,
} from "./types.js";

/**
 * MLX (`mlx_lm.server`, Apple Silicon). OpenAI-compatible chat on /v1 plus a
 * /health route. The server switches models per request (the `model` field
 * may be a local path or a Hugging Face repo id) and keeps one resident, so
 * load is just-in-time. There is no embeddings route and no pull/delete API.
 * Opt-in via MLX_HOST because its default port (8080) collides with
 * llama-server.
 */
export class MlxProvider extends OpenAICompatibleProvider {
  readonly type = "mlx" as const;

  private root(): string {
    return this.host.replace(/\/v1\/?$/i, "");
  }

  protected override v1(): string {
    return `${this.root()}/v1`;
  }

  override capabilities(): ProviderCapabilities {
    return this.caps({ complete: true });
  }

  override async detect(opts: RequestOptions): Promise<boolean> {
    if (await probe(`${this.root()}/health`, opts.timeoutMs, { signal: opts.signal })) return true;
    return super.detect(opts);
  }

  override async health(opts: RequestOptions): Promise<HealthStatus> {
    try {
      const data = await httpJson<{ status?: string }>(`${this.root()}/health`, opts);
      return this.healthy(data.status);
    } catch (err) {
      return this.unhealthy(err);
    }
  }

  /** The server does not report which model is resident. */
  override async listLoaded(_opts: RequestOptions): Promise<LoadedModelInfo[]> {
    return [];
  }

  override async load(model: string): Promise<LifecycleResult & { loaded: boolean }> {
    return {
      provider: this.name,
      model,
      loaded: true,
      detail: "mlx_lm.server loads the requested model on first use (one resident at a time)",
    };
  }

  override async embed(_params: EmbedParams, _opts: RequestOptions): Promise<EmbedResult> {
    this.unsupported("embed", "mlx_lm.server has no embeddings endpoint");
  }
}
