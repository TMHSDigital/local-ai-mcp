import { spawnSync } from "node:child_process";
import { httpJson, probe } from "../http.js";
import { openAiChatComplete } from "./openai-complete.js";
import type {
  CompletionChunkHandler,
  CompletionParams,
  CompletionResult,
  EmbedParams,
  EmbedResult,
  HealthStatus,
  LoadedModelInfo,
  ModelDetail,
  ModelSummary,
  Provider,
  ProviderCapabilities,
  PullResult,
} from "./types.js";

const PROVIDER = "lmstudio" as const;

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type CliRunner = (args: string[]) => CliResult;

function defaultCliRunner(args: string[]): CliResult {
  const res = spawnSync("lms", args, { encoding: "utf8" });
  return {
    status: res.status ?? (res.error ? 1 : 0),
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
  };
}

interface LMStudioModel {
  id: string;
  type?: string;
  state?: string;
  publisher?: string;
  arch?: string;
  quantization?: string;
  max_context_length?: number;
  loaded_context_length?: number;
}

interface OpenAiEmbedResponse {
  data?: Array<{ embedding: number[] }>;
}

export class LMStudioProvider implements Provider {
  readonly id = PROVIDER;
  readonly host: string;
  private cliRunner: CliRunner;
  private lmsAvailableCache: boolean | undefined;

  constructor(host: string, cliRunner: CliRunner = defaultCliRunner) {
    this.host = host;
    this.cliRunner = cliRunner;
  }

  lmsAvailable(): boolean {
    if (this.lmsAvailableCache === undefined) {
      try {
        this.lmsAvailableCache = this.cliRunner(["version"]).status === 0;
      } catch {
        this.lmsAvailableCache = false;
      }
    }
    return this.lmsAvailableCache;
  }

  capabilities(): ProviderCapabilities {
    const cli = this.lmsAvailable();
    return {
      provider: PROVIDER,
      complete: true,
      embed: true,
      pull: cli,
      remove: cli,
      load: cli,
      unload: cli,
      search: false,
    };
  }

  async detect(timeoutMs: number): Promise<boolean> {
    if (await probe(`${this.host}/api/v0/models`, timeoutMs)) return true;
    return probe(`${this.host}/v1/models`, timeoutMs);
  }

  async health(timeoutMs: number): Promise<HealthStatus> {
    const live = await this.detect(timeoutMs);
    return live
      ? { provider: PROVIDER, live: true, host: this.host }
      : {
          provider: PROVIDER,
          live: false,
          host: this.host,
          error: "LM Studio server not reachable",
        };
  }

  private mapModel(m: LMStudioModel): ModelSummary {
    return {
      id: m.id,
      provider: PROVIDER,
      family: m.arch,
      quantization: m.quantization,
    };
  }

  async listModels(timeoutMs: number): Promise<ModelSummary[]> {
    const data = await httpJson<{ data?: LMStudioModel[] }>(`${this.host}/api/v0/models`, {
      timeoutMs,
    });
    return (data.data ?? []).map((m) => this.mapModel(m));
  }

  async listLoaded(timeoutMs: number): Promise<LoadedModelInfo[]> {
    const data = await httpJson<{ data?: LMStudioModel[] }>(`${this.host}/api/v0/models`, {
      timeoutMs,
    });
    return (data.data ?? [])
      .filter((m) => m.state === "loaded")
      .map((m) => ({
        id: m.id,
        provider: PROVIDER,
        contextLength: m.loaded_context_length ?? m.max_context_length,
      }));
  }

  async modelInfo(model: string, timeoutMs: number): Promise<ModelDetail> {
    const m = await httpJson<LMStudioModel>(
      `${this.host}/api/v0/models/${encodeURIComponent(model)}`,
      { timeoutMs },
    );
    return {
      id: m.id ?? model,
      provider: PROVIDER,
      family: m.arch,
      quantization: m.quantization,
      contextLength: m.max_context_length,
      details: m as unknown as Record<string, unknown>,
    };
  }

  async pull(model: string, _timeoutMs: number): Promise<PullResult> {
    if (!this.lmsAvailable()) {
      throw new Error("LM Studio pull requires the lms CLI");
    }
    const res = this.cliRunner(["get", model]);
    if (res.status !== 0) {
      throw new Error(`lms get failed: ${res.stderr || res.stdout}`);
    }
    return { provider: PROVIDER, model, status: "success" };
  }

  async remove(
    model: string,
    _timeoutMs: number,
  ): Promise<{ provider: typeof PROVIDER; model: string; removed: boolean }> {
    if (!this.lmsAvailable()) {
      throw new Error("LM Studio remove requires the lms CLI");
    }
    const res = this.cliRunner(["rm", model]);
    if (res.status !== 0) {
      throw new Error(`lms rm failed: ${res.stderr || res.stdout}`);
    }
    return { provider: PROVIDER, model, removed: true };
  }

  async load(
    model: string,
    _timeoutMs: number,
    _keepAlive?: string,
  ): Promise<{ provider: typeof PROVIDER; model: string; loaded: boolean; detail?: string }> {
    if (this.lmsAvailable()) {
      const res = this.cliRunner(["load", model]);
      if (res.status !== 0) {
        throw new Error(`lms load failed: ${res.stderr || res.stdout}`);
      }
      return { provider: PROVIDER, model, loaded: true };
    }
    return {
      provider: PROVIDER,
      model,
      loaded: true,
      detail: "LM Studio loads on first request (JIT); no CLI present",
    };
  }

  async unload(
    model: string,
    _timeoutMs: number,
  ): Promise<{ provider: typeof PROVIDER; model: string; unloaded: boolean; detail?: string }> {
    if (!this.lmsAvailable()) {
      throw new Error(
        "LM Studio unload requires the lms CLI; install it to unload models",
      );
    }
    const res = this.cliRunner(["unload", model]);
    if (res.status !== 0) {
      throw new Error(`lms unload failed: ${res.stderr || res.stdout}`);
    }
    return { provider: PROVIDER, model, unloaded: true };
  }

  async complete(
    params: CompletionParams,
    timeoutMs: number,
    onChunk?: CompletionChunkHandler,
  ): Promise<CompletionResult> {
    return openAiChatComplete(
      `${this.host}/v1/chat/completions`,
      PROVIDER,
      params,
      timeoutMs,
      { onChunk },
    );
  }

  async embed(params: EmbedParams, timeoutMs: number): Promise<EmbedResult> {
    const data = await httpJson<OpenAiEmbedResponse>(`${this.host}/v1/embeddings`, {
      method: "POST",
      body: JSON.stringify({ model: params.model, input: params.input }),
      timeoutMs,
    });
    const embeddings = (data.data ?? []).map((d) => d.embedding);
    return {
      provider: PROVIDER,
      model: params.model,
      embeddings,
      dimensions: embeddings[0]?.length ?? 0,
    };
  }
}
