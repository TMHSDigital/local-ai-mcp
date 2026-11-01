import { httpJson, httpStreamLines, probe } from "../http.js";
import { OpenAICompatibleProvider } from "./base.js";
import type {
  HealthStatus,
  LifecycleResult,
  ModelSummary,
  ProviderCapabilities,
  PullProgressHandler,
  PullResult,
  RequestOptions,
} from "./types.js";

interface DmrModel {
  id?: string;
  tags?: string[];
  created?: number;
  config?: {
    format?: string;
    quantization?: string;
    parameters?: string;
    architecture?: string;
    size?: string;
    context_size?: number;
  };
}

/** "4.68 GiB" / "512.00 MB" -> bytes. */
export function parseHumanSize(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = value.trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!m) return undefined;
  const unit = m[2].toUpperCase();
  const pow = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4 }[unit];
  if (pow === undefined) return undefined;
  const base = unit.includes("I") ? 1024 : 1000;
  return Math.round(Number(m[1]) * base ** pow);
}

function modelPath(model: string): string {
  return model.split("/").map(encodeURIComponent).join("/");
}

/**
 * Docker Model Runner (Docker Desktop / Docker Engine). Native model
 * management on the host TCP port (default 12434: GET/DELETE /models,
 * POST /models/create) plus OpenAI-compatible routes under /engines/v1.
 * Models load on first request; there is no explicit load/unload API.
 * Requires host-side TCP access to be enabled in Docker Desktop.
 */
export class DockerModelRunnerProvider extends OpenAICompatibleProvider {
  readonly type = "dockermodelrunner" as const;

  protected override v1(): string {
    return `${this.host}/engines/v1`;
  }

  override capabilities(): ProviderCapabilities {
    return this.caps({ complete: true, embed: true, pull: true, remove: true, structuredOutput: true });
  }

  override async detect(opts: RequestOptions): Promise<boolean> {
    if (await probe(`${this.host}/models`, opts.timeoutMs, { signal: opts.signal })) return true;
    return super.detect(opts);
  }

  override async health(opts: RequestOptions): Promise<HealthStatus> {
    try {
      await httpJson(`${this.host}/models`, opts);
      return this.healthy();
    } catch (err) {
      return this.unhealthy(err);
    }
  }

  override async listModels(opts: RequestOptions): Promise<ModelSummary[]> {
    let native: DmrModel[] | undefined;
    try {
      const data = await httpJson<DmrModel[] | { models?: DmrModel[] }>(`${this.host}/models`, opts);
      native = Array.isArray(data) ? data : data.models;
    } catch {
      native = undefined;
    }
    if (!native) return super.listModels(opts);
    return native.flatMap((m) => {
      const ids = m.tags && m.tags.length > 0 ? m.tags : m.id ? [m.id] : [];
      return ids.map((id) => ({
        id,
        provider: this.name,
        ...(m.config?.architecture ? { family: m.config.architecture } : {}),
        ...(m.config?.parameters ? { parameterSize: m.config.parameters.replace(/\s+/g, "") } : {}),
        ...(m.config?.quantization ? { quantization: m.config.quantization } : {}),
        ...(parseHumanSize(m.config?.size) ? { sizeBytes: parseHumanSize(m.config?.size) } : {}),
        ...(m.config?.context_size ? { contextLength: m.config.context_size } : {}),
      }));
    });
  }

  /** Loaded state is not exposed over the API. */
  override async listLoaded(_opts: RequestOptions) {
    return [];
  }

  override async pull(
    model: string,
    opts: RequestOptions & { onProgress?: PullProgressHandler },
  ): Promise<PullResult> {
    let status = "success";
    await httpStreamLines(
      `${this.host}/models/create`,
      {
        method: "POST",
        body: JSON.stringify({ from: model }),
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      },
      "application/json",
      async (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let evt: { type?: string; message?: string; total?: number; pulled?: number; error?: string };
        try {
          evt = JSON.parse(trimmed);
        } catch {
          status = trimmed;
          await opts.onProgress?.({ status: trimmed });
          return;
        }
        if (evt.type === "error" || evt.error) throw new Error(evt.error ?? evt.message ?? "pull failed");
        if (evt.message) status = evt.message;
        await opts.onProgress?.({
          status: evt.message ?? evt.type ?? "pulling",
          ...(evt.pulled !== undefined ? { completed: evt.pulled } : {}),
          ...(evt.total !== undefined ? { total: evt.total } : {}),
        });
      },
    );
    return { provider: this.name, model, status };
  }

  override async remove(model: string, opts: RequestOptions): Promise<LifecycleResult & { removed: boolean }> {
    await httpJson(`${this.host}/models/${modelPath(model)}`, { method: "DELETE", ...opts });
    return { provider: this.name, model, removed: true };
  }

  override async load(model: string): Promise<LifecycleResult & { loaded: boolean }> {
    return {
      provider: this.name,
      model,
      loaded: true,
      detail: "Docker Model Runner loads models on first request",
    };
  }
}
