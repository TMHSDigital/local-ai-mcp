import { httpJson, httpText, probe } from "../http.js";
import { OpenAICompatibleProvider } from "./base.js";
import type { HealthStatus, ProviderCapabilities, RequestOptions } from "./types.js";

/** Pick the vLLM gauges that matter for ops out of Prometheus text. */
export function parseVllmMetrics(text: string): Record<string, number> {
  const wanted: Record<string, string> = {
    "vllm:kv_cache_usage_perc": "kvCacheUsage",
    "vllm:gpu_cache_usage_perc": "kvCacheUsage", // pre-V1 name
    "vllm:num_requests_running": "requestsRunning",
    "vllm:num_requests_waiting": "requestsWaiting",
  };
  const out: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([a-zA-Z_:][\w:]*)(?:\{[^}]*\})?\s+([-+\d.eE]+|NaN)/);
    if (!m) continue;
    const key = wanted[m[1]];
    const value = Number(m[2]);
    if (!key || !Number.isFinite(value)) continue;
    // Sum across label sets (e.g. per-engine series).
    out[key] = (out[key] ?? 0) + value;
  }
  return out;
}

/**
 * vLLM OpenAI-compatible server (`vllm serve`). One model per server, no
 * lifecycle API. Adds /health, /version and Prometheus /metrics (KV-cache
 * usage, running/waiting requests) on top of the OpenAI routes. /v1/models
 * entries carry max_model_len, mapped to contextLength.
 */
export class VllmProvider extends OpenAICompatibleProvider {
  readonly type = "vllm" as const;

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
    if (await probe(`${this.root()}/health`, opts.timeoutMs, { headers: this.authHeaders(), signal: opts.signal })) {
      return true;
    }
    return super.detect(opts);
  }

  override async health(opts: RequestOptions): Promise<HealthStatus> {
    try {
      await httpText(`${this.root()}/health`, { headers: this.authHeaders(), ...opts });
    } catch (err) {
      return this.unhealthy(err);
    }
    const [version, metrics] = await Promise.all([
      httpJson<{ version?: string }>(`${this.root()}/version`, { headers: this.authHeaders(), ...opts })
        .then((d) => d.version)
        .catch(() => undefined),
      httpText(`${this.root()}/metrics`, { headers: this.authHeaders(), ...opts })
        .then(parseVllmMetrics)
        .catch(() => undefined),
    ]);
    return {
      ...this.healthy(version),
      ...(metrics && Object.keys(metrics).length ? { metrics } : {}),
    };
  }
}
