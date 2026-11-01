import { vi } from "vitest";
import type { Config } from "../config.js";
import { loadConfig } from "../config.js";
import type { HardwareProbe, SystemResources } from "../hardware/index.js";
import {
  UnsupportedOperationError,
  type CompletionChunkHandler,
  type CompletionParams,
  type CompletionResult,
  type LoadedModelInfo,
  type ModelSummary,
  type Provider,
  type ProviderCapabilities,
  type ProviderId,
  type ProviderKind,
  type PullProgressHandler,
} from "../providers/types.js";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockReply {
  status?: number;
  /** JSON-serialised as the body. */
  body?: unknown;
  /** Raw text body (wins over body). */
  text?: string;
  /** Streamed body chunks. */
  chunks?: string[];
  /** Delay before each chunk (ms). */
  chunkDelayMs?: number;
}

/** Stub global fetch with real Response objects so streaming code paths run. */
export function mockFetch(handler: (url: string, init?: RequestInit) => MockReply | Promise<MockReply>) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body,
    });
    if (init?.signal?.aborted) throw init.signal.reason ?? new Error("aborted");
    const reply = await handler(String(url), init);
    const status = reply.status ?? 200;
    if (reply.chunks) {
      const enc = new TextEncoder();
      const chunks = reply.chunks;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const c of chunks) {
            if (reply.chunkDelayMs) await new Promise((r) => setTimeout(r, reply.chunkDelayMs));
            if (init?.signal?.aborted) {
              controller.error(init.signal.reason);
              return;
            }
            controller.enqueue(enc.encode(c));
          }
          controller.close();
        },
      });
      return new Response(stream, { status });
    }
    const text = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return new Response(text, { status });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

export const GB = 1024 ** 3;

export function resources(over: Partial<SystemResources> = {}): SystemResources {
  return { platform: "linux", ramTotalBytes: 64 * GB, ramFreeBytes: 32 * GB, cpuCount: 8, gpus: [], ...over };
}

export function fakeHardware(r: SystemResources = resources()): HardwareProbe {
  return { getSystemResources: async () => r };
}

export function testConfig(over: Partial<Config> = {}): Config {
  return { ...loadConfig({}), cacheTtlMs: 0, ...over };
}

/** In-memory provider for routing and tool tests. */
export class FakeProvider implements Provider {
  readonly type: ProviderId;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly host: string;
  live = true;
  models: ModelSummary[];
  loaded: LoadedModelInfo[];
  caps: Partial<ProviderCapabilities>;
  calls: Array<{ op: string; model?: string; args?: unknown }> = [];
  reply = "ok";

  constructor(
    name: string,
    opts: {
      type?: ProviderId;
      kind?: ProviderKind;
      models?: Array<string | Partial<ModelSummary>>;
      loaded?: Array<string | Partial<LoadedModelInfo>>;
      caps?: Partial<ProviderCapabilities>;
    } = {},
  ) {
    this.name = name;
    this.type = opts.type ?? "ollama";
    this.kind = opts.kind ?? "local";
    this.host = `http://${name}.test`;
    this.models = (opts.models ?? []).map((m) =>
      typeof m === "string" ? { id: m, provider: name } : { provider: name, id: "", ...m },
    );
    this.loaded = (opts.loaded ?? []).map((m) =>
      typeof m === "string" ? { id: m, provider: name } : { provider: name, id: "", ...m },
    );
    this.caps = opts.caps ?? {};
  }

  capabilities(): ProviderCapabilities {
    return {
      provider: this.name,
      type: this.type,
      kind: this.kind,
      complete: true,
      embed: true,
      pull: true,
      remove: true,
      load: true,
      unload: true,
      contextLength: true,
      structuredOutput: true,
      ...this.caps,
    };
  }
  async detect() {
    this.calls.push({ op: "detect" });
    return this.live;
  }
  async health() {
    return { provider: this.name, type: this.type, kind: this.kind, live: this.live, host: this.host };
  }
  async listModels() {
    this.calls.push({ op: "listModels" });
    return this.models;
  }
  async listLoaded() {
    return this.loaded;
  }
  async modelInfo(model: string) {
    const m = this.models.find((x) => x.id === model);
    if (!m) throw new Error(`not found: ${model}`);
    return { ...m };
  }
  async pull(model: string, opts: { onProgress?: PullProgressHandler }) {
    this.calls.push({ op: "pull", model });
    await opts.onProgress?.({ status: "downloading", completed: 50, total: 100 });
    await opts.onProgress?.({ status: "success", completed: 100, total: 100 });
    this.models.push({ id: model, provider: this.name });
    return { provider: this.name, model, status: "success" };
  }
  async remove(model: string) {
    this.calls.push({ op: "remove", model });
    return { provider: this.name, model, removed: true };
  }
  async load(model: string, opts: { keepAlive?: string; contextLength?: number }) {
    if (!this.capabilities().load) throw new UnsupportedOperationError(this.name, "load");
    this.calls.push({ op: "load", model, args: { keepAlive: opts.keepAlive, contextLength: opts.contextLength } });
    this.loaded.push({ id: model, provider: this.name });
    return { provider: this.name, model, loaded: true };
  }
  async unload(model: string) {
    this.calls.push({ op: "unload", model });
    this.loaded = this.loaded.filter((m) => m.id !== model);
    return { provider: this.name, model, unloaded: true };
  }
  async complete(params: CompletionParams, opts: { onChunk?: CompletionChunkHandler }): Promise<CompletionResult> {
    this.calls.push({ op: "complete", model: params.model, args: params });
    if (opts.onChunk) {
      await opts.onChunk({ text: this.reply, done: false });
      await opts.onChunk({ text: "", done: true });
    }
    return {
      provider: this.name,
      host: this.host,
      local: this.kind === "local",
      model: params.model,
      text: this.reply,
      completionTokens: 10,
      promptTokens: 5,
      timings: { ttftMs: 10, evalMs: 100, promptEvalMs: 5 },
      streamed: !!opts.onChunk,
    };
  }
  async embed(params: { model: string; input: string | string[] }) {
    this.calls.push({ op: "embed", model: params.model });
    const n = Array.isArray(params.input) ? params.input.length : 1;
    return {
      provider: this.name,
      host: this.host,
      local: this.kind === "local",
      model: params.model,
      embeddings: Array.from({ length: n }, () => [0.1, 0.2]),
      dimensions: 2,
    };
  }
}
