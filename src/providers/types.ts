export const PROVIDER_IDS = [
  "ollama",
  "lmstudio",
  "llamacpp",
  "openaicompat",
  "moonshot",
  "dockermodelrunner",
  "mlx",
  "foundrylocal",
  "vllm",
] as const;

/** Adapter type. Several configured instances may share one type. */
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Where inference runs. "local" means this machine or a private network host;
 * "hosted" means a third-party API. Implicit routing never picks a hosted
 * provider unless LOCAL_AI_ALLOW_HOSTED_FALLBACK is set.
 */
export type ProviderKind = "local" | "hosted";

/** Per-call transport options shared by every provider method. */
export interface RequestOptions {
  timeoutMs: number;
  /** Abort when the caller (e.g. the MCP client) cancels. */
  signal?: AbortSignal;
}

export interface ModelSummary {
  id: string;
  /** Instance name of the provider that has this model. */
  provider: string;
  sizeBytes?: number;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  modifiedAt?: string;
  contextLength?: number;
}

export interface LoadedModelInfo {
  id: string;
  provider: string;
  sizeVramBytes?: number;
  sizeBytes?: number;
  expiresAt?: string;
  contextLength?: number;
}

/** Transformer shape used for exact KV-cache sizing. */
export interface ModelArchitecture {
  layers: number;
  /** KV heads (GQA). */
  kvHeads: number;
  keyLength: number;
  valueLength: number;
}

export interface ModelDetail extends ModelSummary {
  architecture?: ModelArchitecture;
  details?: Record<string, unknown>;
}

export type ContentPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      /** Base64 image data (no data: prefix). */
      data?: string;
      mimeType?: string;
      url?: string;
    };

export interface ChatMessage {
  role: string;
  content: string | ContentPart[];
}

export type ResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; schema: Record<string, unknown>; name?: string };

export interface CompletionParams {
  model: string;
  prompt?: string;
  system?: string;
  messages?: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  repeatPenalty?: number;
  stop?: string[];
  /** Context window to run with (Ollama num_ctx). */
  contextLength?: number;
  responseFormat?: ResponseFormat;
  /** Provider-specific extras passed through as-is. */
  options?: Record<string, unknown>;
}

/** Incremental token/text callback for streamed completions. */
export type CompletionChunkHandler = (chunk: {
  text: string;
  done: boolean;
}) => void | Promise<void>;

export interface CompletionTimings {
  loadMs?: number;
  /** Time to first token, measured client-side when streaming. */
  ttftMs?: number;
  promptEvalMs?: number;
  evalMs?: number;
}

export interface CompletionResult {
  provider: string;
  host: string;
  local: boolean;
  model: string;
  text: string;
  /** Parsed JSON when a responseFormat was requested and the output parsed. */
  parsed?: unknown;
  promptTokens?: number;
  completionTokens?: number;
  /** True when token counts are estimates (provider returned no usage). */
  usageEstimated?: boolean;
  totalDurationMs?: number;
  /** True when the provider used streaming to assemble the result. */
  streamed?: boolean;
  timings?: CompletionTimings;
  /** Which optional parameters the provider actually honored. */
  applied?: { contextLength?: boolean; responseFormat?: boolean };
  warnings?: string[];
}

export interface EmbedParams {
  model: string;
  input: string | string[];
}

export interface EmbedResult {
  provider: string;
  host: string;
  local: boolean;
  model: string;
  embeddings: number[][];
  dimensions: number;
}

export interface HealthStatus {
  provider: string;
  type: ProviderId;
  kind: ProviderKind;
  live: boolean;
  host: string;
  version?: string;
  error?: string;
  /** Runtime-specific live metrics (e.g. vLLM KV-cache usage, queue depth). */
  metrics?: Record<string, number>;
}

export interface ProviderCapabilities {
  provider: string;
  type: ProviderId;
  kind: ProviderKind;
  complete: boolean;
  embed: boolean;
  pull: boolean;
  remove: boolean;
  load: boolean;
  unload: boolean;
  /** Can set the context window per request (e.g. Ollama num_ctx). */
  contextLength: boolean;
  /** Supports JSON-schema constrained output. */
  structuredOutput: boolean;
}

export type Capability = Exclude<keyof ProviderCapabilities, "provider" | "type" | "kind">;

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}

export type PullProgressHandler = (p: PullProgress) => void | Promise<void>;

export interface PullResult {
  provider: string;
  model: string;
  status: string;
}

export interface LifecycleResult {
  provider: string;
  model: string;
  detail?: string;
}

/** Thrown for operations a provider does not support. */
export class UnsupportedOperationError extends Error {
  constructor(provider: string, op: string, hint?: string) {
    super(`${provider} does not support ${op}${hint ? `; ${hint}` : ""}`);
    this.name = "UnsupportedOperationError";
  }
}

export class ModelNotFoundError extends Error {
  constructor(provider: string, model: string) {
    super(`Model not found on ${provider}: ${model}`);
    this.name = "ModelNotFoundError";
  }
}

export interface Provider {
  /** Adapter type. */
  readonly type: ProviderId;
  /** Unique instance name used in tool `provider` args (defaults to the type). */
  readonly name: string;
  readonly kind: ProviderKind;
  readonly host: string;
  capabilities(): ProviderCapabilities;
  detect(opts: RequestOptions): Promise<boolean>;
  health(opts: RequestOptions): Promise<HealthStatus>;
  listModels(opts: RequestOptions): Promise<ModelSummary[]>;
  listLoaded(opts: RequestOptions): Promise<LoadedModelInfo[]>;
  modelInfo(model: string, opts: RequestOptions): Promise<ModelDetail>;
  pull(
    model: string,
    opts: RequestOptions & { onProgress?: PullProgressHandler },
  ): Promise<PullResult>;
  remove(model: string, opts: RequestOptions): Promise<LifecycleResult & { removed: boolean }>;
  load(
    model: string,
    opts: RequestOptions & { keepAlive?: string; contextLength?: number },
  ): Promise<LifecycleResult & { loaded: boolean }>;
  unload(model: string, opts: RequestOptions): Promise<LifecycleResult & { unloaded: boolean }>;
  complete(
    params: CompletionParams,
    opts: RequestOptions & { onChunk?: CompletionChunkHandler; idleTimeoutMs?: number },
  ): Promise<CompletionResult>;
  embed(params: EmbedParams, opts: RequestOptions): Promise<EmbedResult>;
}
