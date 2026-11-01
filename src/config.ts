import { PROVIDER_IDS, type ProviderId, type ProviderKind } from "./providers/types.js";

/** One configured provider instance. */
export interface ProviderInstanceConfig {
  type: ProviderId;
  /** Unique name used as the tool `provider` argument. Defaults to the type. */
  name: string;
  host: string;
  apiKey?: string;
  /** Overrides host-based local/hosted inference. */
  kind?: ProviderKind;
}

export interface Config {
  providers: ProviderInstanceConfig[];
  /** Allow implicit routing (no `provider` arg) to fall back to hosted providers. */
  allowHostedFallback: boolean;
  /** Allow search_models to query Hugging Face. */
  allowNetworkSearch: boolean;
  requestTimeoutMs: number;
  detectTimeoutMs: number;
  pullTimeoutMs: number;
  /** Abort a streamed completion when no tokens arrive for this long. 0 disables. */
  streamIdleTimeoutMs: number;
  /** Overall cap for a streamed completion (idle timeout does the real work). 0 disables. */
  streamMaxMs: number;
  /** How long detection / model-list results are cached. 0 disables. */
  cacheTtlMs: number;
}

export function normalizeHost(value: string): string {
  let host = value.trim();
  if (!/^https?:\/\//i.test(host)) {
    host = `http://${host}`;
  }
  return host.replace(/\/+$/, "");
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Like parseIntEnv but allows 0 (used to disable a timeout entirely).
function parseNonNegativeEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseBoolEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Loopback, RFC 1918 / link-local / CGNAT ranges, IPv6 ULA, *.local and the
 * Docker host aliases count as local. Anything else is treated as hosted so
 * implicit routing never sends data off-network by surprise.
 */
export function inferKind(host: string): ProviderKind {
  let hostname: string;
  try {
    hostname = new URL(host).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "hosted";
  }
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "::1" ||
    hostname === "0.0.0.0"
  ) {
    return "local";
  }
  const v4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10) return "local";
    if (a === 192 && b === 168) return "local";
    if (a === 172 && b >= 16 && b <= 31) return "local";
    if (a === 169 && b === 254) return "local";
    if (a === 100 && b >= 64 && b <= 127) return "local"; // CGNAT / Tailscale
    return "hosted";
  }
  if (/^f[cd][0-9a-f]{2}:/.test(hostname) || hostname.startsWith("fe80:")) return "local";
  return "hosted";
}

function parseExtraProviders(raw: string | undefined): ProviderInstanceConfig[] {
  if (!raw || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `LOCAL_AI_PROVIDERS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("LOCAL_AI_PROVIDERS must be a JSON array of {type, host, name?, apiKey?, kind?}");
  }
  return parsed.map((entry, i) => {
    const e = entry as Partial<ProviderInstanceConfig>;
    if (!e || typeof e.type !== "string" || !(PROVIDER_IDS as readonly string[]).includes(e.type)) {
      throw new Error(
        `LOCAL_AI_PROVIDERS[${i}].type must be one of: ${PROVIDER_IDS.join(", ")}`,
      );
    }
    if (typeof e.host !== "string" || e.host.trim() === "") {
      throw new Error(`LOCAL_AI_PROVIDERS[${i}].host is required`);
    }
    if (e.kind !== undefined && e.kind !== "local" && e.kind !== "hosted") {
      throw new Error(`LOCAL_AI_PROVIDERS[${i}].kind must be "local" or "hosted"`);
    }
    return {
      type: e.type,
      name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : e.type,
      host: normalizeHost(e.host),
      apiKey: typeof e.apiKey === "string" && e.apiKey.trim() ? e.apiKey.trim() : undefined,
      kind: e.kind,
    };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const disabled = new Set(
    (env.LOCAL_AI_DISABLE ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const providers: ProviderInstanceConfig[] = [];
  const add = (p: ProviderInstanceConfig) => {
    if (!disabled.has(p.type) && !disabled.has(p.name)) providers.push(p);
  };
  const optionalHost = (v: string | undefined) => (v?.trim() ? normalizeHost(v) : undefined);

  // Always-on local runtimes with well-known, distinct default ports.
  add({ type: "ollama", name: "ollama", host: normalizeHost(env.OLLAMA_HOST ?? "http://localhost:11434") });
  add({ type: "lmstudio", name: "lmstudio", host: normalizeHost(env.LMSTUDIO_HOST ?? "http://localhost:1234") });
  add({ type: "llamacpp", name: "llamacpp", host: normalizeHost(env.LLAMACPP_HOST ?? "http://localhost:8080") });
  add({
    type: "dockermodelrunner",
    name: "dockermodelrunner",
    host: normalizeHost(env.DOCKER_MODEL_RUNNER_HOST ?? "http://localhost:12434"),
  });

  // Opt-in runtimes: their default ports collide with other servers or are dynamic.
  const openaiCompat = optionalHost(env.OPENAI_COMPAT_HOST);
  if (openaiCompat) {
    add({
      type: "openaicompat",
      name: "openaicompat",
      host: openaiCompat,
      apiKey: env.OPENAI_COMPAT_API_KEY?.trim() || undefined,
    });
  }
  const mlx = optionalHost(env.MLX_HOST);
  if (mlx) add({ type: "mlx", name: "mlx", host: mlx });
  const vllm = optionalHost(env.VLLM_HOST);
  if (vllm) {
    add({ type: "vllm", name: "vllm", host: vllm, apiKey: env.VLLM_API_KEY?.trim() || undefined });
  }
  const foundry = optionalHost(env.FOUNDRY_LOCAL_HOST);
  if (foundry) add({ type: "foundrylocal", name: "foundrylocal", host: foundry });

  // Hosted: registered only when a key is present.
  const moonshotKey = env.MOONSHOT_API_KEY?.trim();
  if (moonshotKey) {
    add({
      type: "moonshot",
      name: "moonshot",
      host: normalizeHost(env.MOONSHOT_HOST ?? "https://api.moonshot.ai/v1"),
      apiKey: moonshotKey,
      kind: "hosted",
    });
  }

  for (const extra of parseExtraProviders(env.LOCAL_AI_PROVIDERS)) add(extra);

  const seen = new Set<string>();
  for (const p of providers) {
    if (seen.has(p.name)) {
      throw new Error(
        `Duplicate provider name "${p.name}". Give extra instances a unique "name" in LOCAL_AI_PROVIDERS.`,
      );
    }
    seen.add(p.name);
  }

  return {
    providers,
    allowHostedFallback: parseBoolEnv(env.LOCAL_AI_ALLOW_HOSTED_FALLBACK),
    allowNetworkSearch: !parseBoolEnv(env.LOCAL_AI_DISABLE_NETWORK_SEARCH),
    requestTimeoutMs: parseIntEnv(env.LOCAL_AI_REQUEST_TIMEOUT_MS, 120000),
    detectTimeoutMs: parseIntEnv(env.LOCAL_AI_DETECT_TIMEOUT_MS, 1500),
    pullTimeoutMs: parseNonNegativeEnv(env.LOCAL_AI_PULL_TIMEOUT_MS, 3600000),
    streamIdleTimeoutMs: parseNonNegativeEnv(env.LOCAL_AI_STREAM_IDLE_TIMEOUT_MS, 60000),
    streamMaxMs: parseNonNegativeEnv(env.LOCAL_AI_STREAM_MAX_MS, 1800000),
    cacheTtlMs: parseNonNegativeEnv(env.LOCAL_AI_CACHE_TTL_MS, 10000),
  };
}
