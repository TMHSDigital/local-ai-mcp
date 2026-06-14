export type ProviderId = "ollama" | "lmstudio";

export interface ModelSummary {
  id: string;
  provider: ProviderId;
  sizeBytes?: number;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  modifiedAt?: string;
}

export interface LoadedModelInfo {
  id: string;
  provider: ProviderId;
  sizeVramBytes?: number;
  expiresAt?: string;
  contextLength?: number;
}

export interface ModelDetail extends ModelSummary {
  contextLength?: number;
  details?: Record<string, unknown>;
}

export interface CompletionParams {
  model: string;
  prompt?: string;
  messages?: Array<{ role: string; content: string }>;
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
}

export interface CompletionResult {
  provider: ProviderId;
  model: string;
  text: string;
  promptTokens?: number;
  completionTokens?: number;
  totalDurationMs?: number;
}

export interface EmbedParams {
  model: string;
  input: string | string[];
}

export interface EmbedResult {
  provider: ProviderId;
  model: string;
  embeddings: number[][];
  dimensions: number;
}

export interface HealthStatus {
  provider: ProviderId;
  live: boolean;
  host: string;
  version?: string;
  error?: string;
}

export interface ProviderCapabilities {
  provider: ProviderId;
  complete: boolean;
  embed: boolean;
  pull: boolean;
  remove: boolean;
  load: boolean;
  unload: boolean;
  search: boolean;
}

export interface PullResult {
  provider: ProviderId;
  model: string;
  status: string;
}

export interface Provider {
  readonly id: ProviderId;
  readonly host: string;
  capabilities(): ProviderCapabilities;
  detect(timeoutMs: number): Promise<boolean>;
  health(timeoutMs: number): Promise<HealthStatus>;
  listModels(timeoutMs: number): Promise<ModelSummary[]>;
  listLoaded(timeoutMs: number): Promise<LoadedModelInfo[]>;
  modelInfo(model: string, timeoutMs: number): Promise<ModelDetail>;
  pull(model: string, timeoutMs: number): Promise<PullResult>;
  remove(
    model: string,
    timeoutMs: number,
  ): Promise<{ provider: ProviderId; model: string; removed: boolean }>;
  load(
    model: string,
    timeoutMs: number,
    keepAlive?: string,
  ): Promise<{ provider: ProviderId; model: string; loaded: boolean; detail?: string }>;
  unload(
    model: string,
    timeoutMs: number,
  ): Promise<{ provider: ProviderId; model: string; unloaded: boolean; detail?: string }>;
  complete(params: CompletionParams, timeoutMs: number): Promise<CompletionResult>;
  embed(params: EmbedParams, timeoutMs: number): Promise<EmbedResult>;
}
