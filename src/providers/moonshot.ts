import { OpenAICompatibleProvider, type ProviderOptions } from "./base.js";
import type {
  EmbedParams,
  EmbedResult,
  LoadedModelInfo,
  ProviderCapabilities,
  RequestOptions,
} from "./types.js";

/**
 * Moonshot AI (Kimi) hosted API (https://api.moonshot.ai/v1). Always "hosted":
 * implicit routing never selects it unless LOCAL_AI_ALLOW_HOSTED_FALLBACK is
 * set. Models are managed by Moonshot, so there is no lifecycle. The host is
 * expected to include the /v1 path segment.
 */
export class MoonshotProvider extends OpenAICompatibleProvider {
  readonly type = "moonshot" as const;

  constructor(host: string, opts: ProviderOptions = {}) {
    super(host, { ...opts, kind: opts.kind ?? "hosted" });
  }

  protected override authHeaders(): Record<string, string> {
    if (!this.apiKey) {
      throw new Error("MOONSHOT_API_KEY is not set; set it to use the moonshot provider");
    }
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  override capabilities(): ProviderCapabilities {
    return this.caps({ complete: true, structuredOutput: true });
  }

  /**
   * Configured == available. No network probe: this keeps routine tool calls
   * from making a cloud round-trip. health_check does the real check.
   */
  override async detect(_opts: RequestOptions): Promise<boolean> {
    return !!this.apiKey;
  }

  override async listLoaded(_opts: RequestOptions): Promise<LoadedModelInfo[]> {
    // Hosted API: nothing is "loaded" locally.
    return [];
  }

  override async embed(_params: EmbedParams, _opts: RequestOptions): Promise<EmbedResult> {
    this.unsupported("embed", "moonshot does not expose an embeddings endpoint");
  }
}
