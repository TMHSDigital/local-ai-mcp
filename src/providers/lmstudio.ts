import { runCommand, type ExecOptions, type ExecResult } from "../exec.js";
import { httpJson, probe } from "../http.js";
import { OpenAICompatibleProvider, type ProviderOptions } from "./base.js";
import {
  UnsupportedOperationError,
  type HealthStatus,
  type LifecycleResult,
  type LoadedModelInfo,
  type ModelDetail,
  type ModelSummary,
  type ProviderCapabilities,
  type PullProgressHandler,
  type PullResult,
  type RequestOptions,
} from "./types.js";

export type CliResult = ExecResult;
export type CliRunner = (args: string[], opts: ExecOptions) => Promise<CliResult>;

const defaultCliRunner: CliRunner = (args, opts) => runCommand("lms", args, opts);

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

/** "5m" / "1h" / "30s" / "90" -> seconds. */
export function keepAliveToSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/i);
  if (!m) return undefined;
  const mult = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase() as "" | "s" | "m" | "h" | "d"];
  return Math.round(Number(m[1]) * mult);
}

/** Model ids are passed to the lms CLI; reject anything that could parse as a flag. */
function assertModelArg(model: string): void {
  if (!model || model.startsWith("-") || /[\0\r\n]/.test(model)) {
    throw new Error(`Invalid model id: ${JSON.stringify(model)}`);
  }
}

export class LMStudioProvider extends OpenAICompatibleProvider {
  readonly type = "lmstudio" as const;
  private cliRunner: CliRunner;
  private lmsAvailableCache: boolean | undefined;

  constructor(host: string, opts: ProviderOptions & { cliRunner?: CliRunner } = {}) {
    super(host, opts);
    this.cliRunner = opts.cliRunner ?? defaultCliRunner;
  }

  protected override v1(): string {
    return `${this.host}/v1`;
  }

  /** Whether the `lms` CLI is on PATH. Cached after the first check. */
  async lmsAvailable(): Promise<boolean> {
    if (this.lmsAvailableCache === undefined) {
      try {
        this.lmsAvailableCache = (await this.cliRunner(["version"], { timeoutMs: 5000 })).status === 0;
      } catch {
        this.lmsAvailableCache = false;
      }
    }
    return this.lmsAvailableCache;
  }

  /** Lifecycle capabilities reflect the cached CLI check (warmed by detect()). */
  override capabilities(): ProviderCapabilities {
    const cli = this.lmsAvailableCache === true;
    return this.caps({
      complete: true,
      embed: true,
      pull: cli,
      remove: cli,
      load: cli,
      unload: cli,
      structuredOutput: true,
    });
  }

  override async detect(opts: RequestOptions): Promise<boolean> {
    const [rest, openai] = await Promise.all([
      probe(`${this.host}/api/v0/models`, opts.timeoutMs, { signal: opts.signal }),
      probe(`${this.host}/v1/models`, opts.timeoutMs, { signal: opts.signal }),
      this.lmsAvailable(),
    ]);
    return rest || openai;
  }

  override async health(opts: RequestOptions): Promise<HealthStatus> {
    return (await this.detect(opts))
      ? this.healthy()
      : this.unhealthy(new Error("LM Studio server not reachable"));
  }

  private mapLm(m: LMStudioModel): ModelSummary {
    return {
      id: m.id,
      provider: this.name,
      ...(m.arch ? { family: m.arch } : {}),
      ...(m.quantization ? { quantization: m.quantization } : {}),
      ...(m.max_context_length ? { contextLength: m.max_context_length } : {}),
    };
  }

  override async listModels(opts: RequestOptions): Promise<ModelSummary[]> {
    const data = await httpJson<{ data?: LMStudioModel[] }>(`${this.host}/api/v0/models`, opts);
    return (data.data ?? []).map((m) => this.mapLm(m));
  }

  override async listLoaded(opts: RequestOptions): Promise<LoadedModelInfo[]> {
    const data = await httpJson<{ data?: LMStudioModel[] }>(`${this.host}/api/v0/models`, opts);
    return (data.data ?? [])
      .filter((m) => m.state === "loaded")
      .map((m) => ({
        id: m.id,
        provider: this.name,
        contextLength: m.loaded_context_length ?? m.max_context_length,
      }));
  }

  override async modelInfo(model: string, opts: RequestOptions): Promise<ModelDetail> {
    const m = await httpJson<LMStudioModel>(
      `${this.host}/api/v0/models/${encodeURIComponent(model)}`,
      opts,
    );
    return {
      ...this.mapLm({ ...m, id: m.id ?? model }),
      details: m as unknown as Record<string, unknown>,
    };
  }

  private async lms(args: string[], opts: RequestOptions & { onOutput?: (s: string) => void }): Promise<CliResult> {
    if (!(await this.lmsAvailable())) {
      const op = { get: "pull", rm: "remove" }[args[0]] ?? args[0];
      throw new UnsupportedOperationError(this.name, op, "it requires the lms CLI on PATH (https://lmstudio.ai/docs/cli)");
    }
    const res = await this.cliRunner(args, {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onOutput: opts.onOutput,
    });
    if (res.status !== 0) {
      throw new Error(`lms ${args[0]} failed: ${(res.stderr || res.stdout).trim()}`);
    }
    return res;
  }

  override async pull(
    model: string,
    opts: RequestOptions & { onProgress?: PullProgressHandler },
  ): Promise<PullResult> {
    assertModelArg(model);
    let lastPct = -1;
    await this.lms(["get", model, "--yes"], {
      ...opts,
      onOutput: (chunk) => {
        const matches = [...chunk.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
        const last = matches.at(-1);
        if (!last || !opts.onProgress) return;
        const pct = Number(last[1]);
        if (pct === lastPct) return;
        lastPct = pct;
        void opts.onProgress({ status: "downloading", completed: pct, total: 100 });
      },
    });
    return { provider: this.name, model, status: "success" };
  }

  override async remove(model: string, opts: RequestOptions): Promise<LifecycleResult & { removed: boolean }> {
    assertModelArg(model);
    await this.lms(["rm", model, "--yes"], opts);
    return { provider: this.name, model, removed: true };
  }

  override async load(
    model: string,
    opts: RequestOptions & { keepAlive?: string; contextLength?: number },
  ): Promise<LifecycleResult & { loaded: boolean }> {
    assertModelArg(model);
    if (!(await this.lmsAvailable())) {
      return {
        provider: this.name,
        model,
        loaded: true,
        detail: "LM Studio loads on first request (JIT); no lms CLI present",
      };
    }
    const args = ["load", model, "--yes"];
    const ttl = keepAliveToSeconds(opts.keepAlive);
    if (ttl) args.push("--ttl", String(ttl));
    if (opts.contextLength) args.push("--context-length", String(opts.contextLength));
    await this.lms(args, opts);
    return { provider: this.name, model, loaded: true };
  }

  override async unload(model: string, opts: RequestOptions): Promise<LifecycleResult & { unloaded: boolean }> {
    assertModelArg(model);
    await this.lms(["unload", model], opts);
    return { provider: this.name, model, unloaded: true };
  }
}
