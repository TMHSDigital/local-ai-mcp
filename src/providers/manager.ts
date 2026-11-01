import type { Config, ProviderInstanceConfig } from "../config.js";
import { DockerModelRunnerProvider } from "./dockermodelrunner.js";
import { FoundryLocalProvider } from "./foundrylocal.js";
import { LlamaCppProvider } from "./llamacpp.js";
import { LMStudioProvider } from "./lmstudio.js";
import { MlxProvider } from "./mlx.js";
import { MoonshotProvider } from "./moonshot.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAICompatProvider } from "./openaicompat.js";
import { VllmProvider } from "./vllm.js";
import {
  UnsupportedOperationError,
  type Capability,
  type ModelSummary,
  type Provider,
  type RequestOptions,
} from "./types.js";

export function createProvider(cfg: ProviderInstanceConfig): Provider {
  const opts = { name: cfg.name, apiKey: cfg.apiKey, kind: cfg.kind };
  switch (cfg.type) {
    case "ollama":
      return new OllamaProvider(cfg.host, opts);
    case "lmstudio":
      return new LMStudioProvider(cfg.host, opts);
    case "llamacpp":
      return new LlamaCppProvider(cfg.host, opts);
    case "openaicompat":
      return new OpenAICompatProvider(cfg.host, opts);
    case "moonshot":
      return new MoonshotProvider(cfg.host, opts);
    case "dockermodelrunner":
      return new DockerModelRunnerProvider(cfg.host, opts);
    case "mlx":
      return new MlxProvider(cfg.host, opts);
    case "foundrylocal":
      return new FoundryLocalProvider(cfg.host, opts);
    case "vllm":
      return new VllmProvider(cfg.host, opts);
  }
}

/** Ollama treats "llama3" and "llama3:latest" as the same model. */
export function sameModel(a: string, b: string): boolean {
  if (a === b) return true;
  const strip = (s: string) => s.replace(/:latest$/, "");
  return strip(a) === strip(b);
}

interface CacheEntry<T> {
  value: T;
  at: number;
}

export interface SelectOptions {
  /** Capability the chosen provider must have. */
  capability: Capability;
  /** For pulls: allow choosing a provider that does not have the model yet. */
  allowMissing?: boolean;
}

export class ProviderManager {
  readonly providers: Provider[];
  private readonly config: Pick<Config, "allowHostedFallback" | "cacheTtlMs">;
  private detectCache = new Map<string, CacheEntry<boolean>>();
  private modelCache = new Map<string, CacheEntry<ModelSummary[]>>();
  private now: () => number;

  constructor(
    config: Pick<Config, "providers" | "allowHostedFallback" | "cacheTtlMs">,
    deps: { providers?: Provider[]; now?: () => number } = {},
  ) {
    this.providers = deps.providers ?? config.providers.map(createProvider);
    this.config = config;
    this.now = deps.now ?? Date.now;
  }

  names(): string[] {
    return this.providers.map((p) => p.name);
  }

  /** Look up by instance name, or by type when exactly one instance has it. */
  get(nameOrType: string): Provider | undefined {
    const byName = this.providers.find((p) => p.name === nameOrType);
    if (byName) return byName;
    const byType = this.providers.filter((p) => p.type === nameOrType);
    return byType.length === 1 ? byType[0] : undefined;
  }

  require(nameOrType: string): Provider {
    const p = this.get(nameOrType);
    if (!p) {
      throw new Error(
        `Unknown provider: ${nameOrType}. Configured providers: ${this.names().join(", ") || "(none)"}`,
      );
    }
    return p;
  }

  /** Drop cached detection/model lists (all, or one provider's). */
  invalidate(name?: string): void {
    if (name === undefined) {
      this.detectCache.clear();
      this.modelCache.clear();
      return;
    }
    this.detectCache.delete(name);
    this.modelCache.delete(name);
  }

  private fresh<T>(entry: CacheEntry<T> | undefined, ttl: number): entry is CacheEntry<T> {
    return !!entry && ttl > 0 && this.now() - entry.at < ttl;
  }

  async isLive(p: Provider, opts: RequestOptions): Promise<boolean> {
    const cached = this.detectCache.get(p.name);
    // Down providers are re-probed sooner so a freshly started runtime shows up quickly.
    const ttl = cached?.value ? this.config.cacheTtlMs : Math.min(this.config.cacheTtlMs, 3000);
    if (this.fresh(cached, ttl)) return cached.value;
    const live = await p.detect(opts).catch(() => false);
    this.detectCache.set(p.name, { value: live, at: this.now() });
    return live;
  }

  async detected(opts: RequestOptions): Promise<Provider[]> {
    const live = await Promise.all(this.providers.map((p) => this.isLive(p, opts)));
    return this.providers.filter((_, i) => live[i]);
  }

  /** Explicit provider -> [it]; otherwise every live provider. Used by read-only tools. */
  async resolve(providerArg: string | undefined, opts: RequestOptions): Promise<Provider[]> {
    if (providerArg) return [this.require(providerArg)];
    return this.detected(opts);
  }

  async listModelsCached(p: Provider, opts: RequestOptions): Promise<ModelSummary[]> {
    const cached = this.modelCache.get(p.name);
    if (this.fresh(cached, this.config.cacheTtlMs)) return cached.value;
    const models = await p.listModels(opts);
    this.modelCache.set(p.name, { value: models, at: this.now() });
    return models;
  }

  /** Providers (among `pool`) that list `model`. Listing errors are ignored. */
  async locate(model: string, pool: Provider[], opts: RequestOptions): Promise<Provider[]> {
    const has = await Promise.all(
      pool.map(async (p) => {
        const models = await this.listModelsCached(p, opts).catch(() => [] as ModelSummary[]);
        return models.some((m) => sameModel(m.id, model));
      }),
    );
    return pool.filter((_, i) => has[i]);
  }

  /**
   * Pick exactly one provider for a model-scoped operation.
   *
   * - Explicit `provider`: used as-is (must have the capability).
   * - Otherwise: live **local** providers with the capability that have the
   *   model. Hosted providers are only considered when
   *   LOCAL_AI_ALLOW_HOSTED_FALLBACK is set. When several have the model, one
   *   that already has it loaded wins, then configuration order.
   */
  async select(
    providerArg: string | undefined,
    model: string,
    opts: RequestOptions,
    sel: SelectOptions,
  ): Promise<Provider> {
    if (providerArg) {
      const p = this.require(providerArg);
      if (!p.capabilities()[sel.capability]) {
        throw new UnsupportedOperationError(p.name, sel.capability);
      }
      return p;
    }
    const live = (await this.detected(opts)).filter((p) => p.capabilities()[sel.capability]);
    const local = live.filter((p) => p.kind === "local");
    const hosted = live.filter((p) => p.kind === "hosted");
    const pool = this.config.allowHostedFallback ? [...local, ...hosted] : local;
    const hostedHint =
      hosted.length > 0 && !this.config.allowHostedFallback
        ? ` Hosted provider(s) ${hosted.map((p) => p.name).join(", ")} are configured but never used implicitly; pass provider explicitly (or set LOCAL_AI_ALLOW_HOSTED_FALLBACK=1).`
        : "";
    if (pool.length === 0) {
      throw new Error(`No live local provider supports ${sel.capability}.${hostedHint}`);
    }
    const having = await this.locate(model, pool, opts);
    if (having.length === 1) return having[0];
    if (having.length > 1) {
      const loaded = await Promise.all(
        having.map((p) =>
          p
            .listLoaded(opts)
            .then((l) => l.some((m) => sameModel(m.id, model)))
            .catch(() => false),
        ),
      );
      const idx = loaded.indexOf(true);
      return having[idx >= 0 ? idx : 0];
    }
    if (sel.allowMissing) return pool[0];
    throw new Error(
      `Model "${model}" was not found on any live local provider (${pool.map((p) => p.name).join(", ")}). Check list_models, or pass provider explicitly.${hostedHint}`,
    );
  }
}
