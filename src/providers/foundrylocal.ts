import { httpJson, httpStreamLines, probe } from "../http.js";
import { keepAliveToSeconds } from "./lmstudio.js";
import { OpenAICompatibleProvider } from "./base.js";
import type {
  EmbedParams,
  EmbedResult,
  HealthStatus,
  LifecycleResult,
  LoadedModelInfo,
  ModelSummary,
  ProviderCapabilities,
  PullProgressHandler,
  PullResult,
  RequestOptions,
} from "./types.js";

interface FoundryCatalogEntry {
  name?: string;
  displayName?: string;
  alias?: string;
  providerType?: string;
  uri?: string;
  promptTemplate?: unknown;
  publisher?: string;
  fileSizeMb?: number;
}

/**
 * Microsoft Foundry Local. The service port is dynamic, so this adapter is
 * opt-in via FOUNDRY_LOCAL_HOST (find it with `foundry service status`).
 * OpenAI-compatible chat lives under /v1; management uses /openai/* and the
 * catalog is /foundry/list.
 */
export class FoundryLocalProvider extends OpenAICompatibleProvider {
  readonly type = "foundrylocal" as const;

  private root(): string {
    return this.host.replace(/\/v1\/?$/i, "");
  }

  protected override v1(): string {
    return `${this.root()}/v1`;
  }

  override capabilities(): ProviderCapabilities {
    return this.caps({ complete: true, pull: true, load: true, unload: true });
  }

  override async detect(opts: RequestOptions): Promise<boolean> {
    return probe(`${this.root()}/openai/status`, opts.timeoutMs, { signal: opts.signal });
  }

  override async health(opts: RequestOptions): Promise<HealthStatus> {
    try {
      await httpJson(`${this.root()}/openai/status`, opts);
      return this.healthy();
    } catch (err) {
      return this.unhealthy(err);
    }
  }

  override async listModels(opts: RequestOptions): Promise<ModelSummary[]> {
    const names = await httpJson<string[]>(`${this.root()}/openai/models`, opts);
    return (Array.isArray(names) ? names : []).map((id) => ({ id, provider: this.name }));
  }

  override async listLoaded(opts: RequestOptions): Promise<LoadedModelInfo[]> {
    const names = await httpJson<string[]>(`${this.root()}/openai/loadedmodels`, opts);
    return (Array.isArray(names) ? names : []).map((id) => ({ id, provider: this.name }));
  }

  override async load(
    model: string,
    opts: RequestOptions & { keepAlive?: string },
  ): Promise<LifecycleResult & { loaded: boolean }> {
    const ttl = keepAliveToSeconds(opts.keepAlive);
    const qs = ttl ? `?ttl=${ttl}` : "";
    await httpJson(`${this.root()}/openai/load/${encodeURIComponent(model)}${qs}`, {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    return { provider: this.name, model, loaded: true };
  }

  override async unload(model: string, opts: RequestOptions): Promise<LifecycleResult & { unloaded: boolean }> {
    await httpJson(`${this.root()}/openai/unload/${encodeURIComponent(model)}?force=true`, opts);
    return { provider: this.name, model, unloaded: true };
  }

  override async pull(
    model: string,
    opts: RequestOptions & { onProgress?: PullProgressHandler },
  ): Promise<PullResult> {
    const catalog = await httpJson<{ models?: FoundryCatalogEntry[] } | FoundryCatalogEntry[]>(
      `${this.root()}/foundry/list`,
      { timeoutMs: Math.min(opts.timeoutMs || 60000, 60000), signal: opts.signal },
    );
    const entries = Array.isArray(catalog) ? catalog : (catalog.models ?? []);
    const entry = entries.find((e) => e.name === model || e.alias === model || e.displayName === model);
    if (!entry?.uri || !entry.name) {
      throw new Error(`Model ${model} not found in the Foundry Local catalog (/foundry/list)`);
    }
    let result: { Success?: boolean; ErrorMessage?: string } | undefined;
    await httpStreamLines(
      `${this.root()}/openai/download`,
      {
        method: "POST",
        body: JSON.stringify({
          model: {
            Uri: entry.uri,
            Name: entry.name,
            ProviderType: entry.providerType,
            PromptTemplate: entry.promptTemplate,
            Publisher: entry.publisher,
          },
        }),
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      },
      "application/json",
      async (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed.startsWith("{")) {
          try {
            result = JSON.parse(trimmed);
          } catch {
            // ignore partial JSON
          }
          return;
        }
        // Progress lines look like ("file name", 42.5)
        const m = trimmed.match(/\(\s*"?(.*?)"?\s*,\s*([\d.]+)\s*\)/);
        if (m) await opts.onProgress?.({ status: m[1] || "downloading", completed: Number(m[2]), total: 100 });
      },
    );
    if (result && result.Success === false) {
      throw new Error(`Foundry Local download failed: ${result.ErrorMessage ?? "unknown error"}`);
    }
    return { provider: this.name, model, status: "success" };
  }

  override async embed(_params: EmbedParams, _opts: RequestOptions): Promise<EmbedResult> {
    this.unsupported("embed");
  }
}
