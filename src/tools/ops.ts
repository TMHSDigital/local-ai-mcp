import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computeFit, KV_CACHE_TYPES } from "../fit.js";
import type { CompletionResult, Provider } from "../providers/types.js";
import type { ToolContext } from "./context.js";
import { aggregate, anyRecord, type Extra, ok, perProvider, providerArg, reqOpts, safe } from "./helpers.js";
import { sizeModel } from "./sizing.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const round = (n: number | undefined, digits = 1) =>
  n === undefined || !Number.isFinite(n) ? undefined : Number(n.toFixed(digits));

export interface RunMetrics {
  totalMs: number;
  ttftMs?: number;
  loadMs?: number;
  promptTokens?: number;
  completionTokens: number;
  promptTokensPerSec?: number;
  genTokensPerSec?: number;
  estimated: boolean;
}

/**
 * Derive speeds from one completion. Prefers runtime-reported timings
 * (Ollama eval_duration, llama.cpp timings); otherwise generation speed is
 * measured after the first token so load and prompt processing are excluded.
 */
export function runMetrics(result: CompletionResult, totalMs: number): RunMetrics {
  const t = result.timings ?? {};
  const completionTokens = result.completionTokens ?? 0;
  let genTokensPerSec: number | undefined;
  if (t.evalMs && t.evalMs > 0 && completionTokens > 0) {
    genTokensPerSec = (completionTokens / t.evalMs) * 1000;
  } else if (t.ttftMs !== undefined && completionTokens > 1 && totalMs > t.ttftMs) {
    genTokensPerSec = ((completionTokens - 1) / (totalMs - t.ttftMs)) * 1000;
  } else if (completionTokens > 0 && totalMs > 0) {
    genTokensPerSec = (completionTokens / totalMs) * 1000;
  }
  const promptTokensPerSec =
    t.promptEvalMs && t.promptEvalMs > 0 && result.promptTokens
      ? (result.promptTokens / t.promptEvalMs) * 1000
      : undefined;
  return {
    totalMs,
    ...(t.ttftMs !== undefined ? { ttftMs: Math.round(t.ttftMs) } : {}),
    ...(t.loadMs !== undefined ? { loadMs: Math.round(t.loadMs) } : {}),
    ...(result.promptTokens !== undefined ? { promptTokens: result.promptTokens } : {}),
    completionTokens,
    ...(promptTokensPerSec !== undefined ? { promptTokensPerSec: round(promptTokensPerSec) } : {}),
    ...(genTokensPerSec !== undefined ? { genTokensPerSec: round(genTokensPerSec) } : {}),
    estimated: !!result.usageEstimated || (!t.evalMs && t.ttftMs === undefined),
  };
}

async function benchmarkOne(
  ctx: ToolContext,
  p: Provider,
  model: string,
  args: { prompt: string; maxTokens: number; runs: number; warmup: boolean },
  extra: Extra | undefined,
) {
  const { config } = ctx;
  const opts = { ...reqOpts(config.requestTimeoutMs, extra), idleTimeoutMs: config.streamIdleTimeoutMs };
  let coldLoadMs: number | undefined;
  if (args.warmup) {
    const start = Date.now();
    const warm = await p.complete({ model, prompt: "Hi", maxTokens: 1 }, opts);
    coldLoadMs = warm.timings?.loadMs !== undefined ? Math.round(warm.timings.loadMs) : Date.now() - start;
  }
  const runs: RunMetrics[] = [];
  for (let i = 0; i < args.runs; i++) {
    const start = Date.now();
    // Streaming lets us measure time-to-first-token client-side.
    const result = await p.complete(
      { model, prompt: args.prompt, maxTokens: args.maxTokens, temperature: 0 },
      { ...opts, onChunk: () => undefined },
    );
    runs.push(runMetrics(result, Date.now() - start));
  }
  const gen = runs.map((r) => r.genTokensPerSec).filter((v): v is number => v !== undefined);
  const ttft = runs.map((r) => r.ttftMs).filter((v): v is number => v !== undefined);
  const pp = runs.map((r) => r.promptTokensPerSec).filter((v): v is number => v !== undefined);
  return {
    provider: p.name,
    model,
    ...(coldLoadMs !== undefined ? { warmupMs: coldLoadMs } : {}),
    runs: runs.length,
    genTokensPerSec: { median: round(percentile(gen, 50)), p90: round(percentile(gen, 90)) },
    ttftMs: { median: round(percentile(ttft, 50), 0), p90: round(percentile(ttft, 90), 0) },
    ...(pp.length ? { promptTokensPerSec: { median: round(percentile(pp, 50)) } } : {}),
    estimated: runs.some((r) => r.estimated),
    samples: runs,
  };
}

export function register(server: McpServer, ctx: ToolContext): void {
  const { manager, hardware, config } = ctx;

  server.registerTool(
    "health_check",
    {
      title: "Health check",
      description:
        "Check whether each provider is reachable and report its version (and live metrics such as vLLM KV-cache usage). Without provider, checks every configured provider, including hosted ones.",
      inputSchema: { provider: providerArg(ctx).optional() },
      outputSchema: { health: perProvider },
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    safe(async ({ provider }, extra) => {
      const targets = provider ? [manager.require(provider)] : manager.providers;
      const opts = reqOpts(config.detectTimeoutMs, extra);
      const health = await aggregate(ctx, targets, async (p) => {
        const h = await p.health(opts);
        manager.invalidate(p.name);
        return h;
      });
      return ok({ health });
    }),
  );

  server.registerTool(
    "system_resources",
    {
      title: "System resources",
      description:
        "Report local hardware: platform, total/available RAM, CPU count, and GPUs with total/free VRAM (NVIDIA via nvidia-smi, AMD/Intel via sysfs or the Windows registry, Apple Silicon unified memory). Each GPU names its data source.",
      inputSchema: {},
      outputSchema: {
        platform: z.string(),
        ramTotalBytes: z.number(),
        ramFreeBytes: z.number(),
        cpuCount: z.number(),
        gpus: z.array(anyRecord),
      },
      annotations: READ_ONLY,
    },
    safe(async () => ok({ ...(await hardware.getSystemResources()) })),
  );

  server.registerTool(
    "fit_check",
    {
      title: "Fit check",
      description:
        "Will a model run on this machine, and where? Uses the installed model's size and exact layer architecture when the runtime exposes it (else parameter-count or catalog estimates) to size weights + KV cache for a context length, then compares with free VRAM summed across GPUs and available RAM. Returns target gpu / partial (GPU+CPU split) / cpu / none, with the numbers and how the KV estimate was made. Credits back memory the model already uses if it is loaded.",
      inputSchema: {
        model: z.string().describe("Model id/name to check"),
        sizeBytes: z.number().positive().optional().describe("Explicit weight size in bytes (overrides lookup)"),
        contextLength: z.number().int().positive().optional().describe("Context length for the KV-cache estimate (default 4096)"),
        parameterSize: z.string().optional().describe('Parameter size like "7B" (overrides lookup)'),
        kvCacheType: z.enum(KV_CACHE_TYPES).optional().describe("KV cache precision: f16 (default), q8_0, q4_0"),
        provider: providerArg(ctx).optional(),
      },
      outputSchema: {
        model: z.string(),
        fits: z.boolean(),
        target: z.enum(["gpu", "partial", "cpu", "none"]),
        sizeSource: z.string(),
        loaded: z.boolean(),
        requiredBytes: z.number(),
        availableBytes: z.number(),
        note: z.string(),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ model, sizeBytes, contextLength, parameterSize, kvCacheType, provider }, extra) => {
      const detectOpts = reqOpts(config.detectTimeoutMs, extra);
      const opts = reqOpts(config.requestTimeoutMs, extra);
      let p: Provider | undefined;
      if (provider) p = manager.require(provider);
      else {
        const live = (await manager.detected(detectOpts)).filter((x) => x.kind === "local");
        p = (await manager.locate(model, live, opts))[0];
      }
      const sizing = await sizeModel(ctx, p, model, opts, { sizeBytes, parameterSize });
      if (sizing.weightBytes === undefined) {
        throw new Error(
          `Could not determine size for "${model}" from a provider or the catalog. Pass sizeBytes (and parameterSize) to check fit explicitly.`,
        );
      }
      const resources = await hardware.getSystemResources();
      const outcome = computeFit(resources, sizing.weightBytes, {
        contextLength,
        parameterSize: sizing.parameterSize,
        architecture: sizing.architecture,
        kvCacheType,
        residentVramBytes: sizing.residentVramBytes,
        residentRamBytes: sizing.residentRamBytes,
      });
      return ok({
        model,
        ...(p ? { provider: p.name } : {}),
        sizeSource: sizing.source,
        loaded: sizing.loaded,
        ...(sizing.maxContextLength ? { maxContextLength: sizing.maxContextLength } : {}),
        ...(sizing.maxContextLength && outcome.contextLength > sizing.maxContextLength
          ? { warning: `contextLength exceeds the model's maximum (${sizing.maxContextLength})` }
          : {}),
        ...outcome,
      });
    }),
  );

  server.registerTool(
    "benchmark",
    {
      title: "Benchmark",
      description:
        "HEAVY: Runs REAL inference. Measures a model on this machine with a warmup (absorbs load time) plus N streamed runs: time-to-first-token, generation tokens/sec (runtime-reported when available, else measured after the first token), and prompt-processing speed. Pass models[] to compare several models with the same prompt, ranked by generation speed.",
      inputSchema: {
        model: z.string().optional().describe("Model id/name to benchmark"),
        models: z.array(z.string()).optional().describe("Compare several models (ranked by median generation tokens/sec)"),
        prompt: z.string().optional().describe("Prompt (default: a short fixed prompt)"),
        maxTokens: z.number().int().positive().optional().describe("Tokens to generate per run (default 128)"),
        runs: z.number().int().min(1).max(20).optional().describe("Measured runs per model (default 3)"),
        warmup: z.boolean().optional().describe("Run a 1-token warmup first so load time is excluded (default true)"),
        provider: providerArg(ctx).optional(),
      },
      outputSchema: { results: z.array(anyRecord) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ model, models, prompt, maxTokens, runs, warmup, provider }, extra) => {
      const targets = [...new Set([...(model ? [model] : []), ...(models ?? [])])];
      if (targets.length === 0) throw new Error("Provide model or models[].");
      const args = {
        prompt: prompt ?? "Explain in a few sentences why running language models locally can be useful.",
        maxTokens: maxTokens ?? 128,
        runs: runs ?? 3,
        warmup: warmup ?? true,
      };
      const results: Record<string, unknown>[] = [];
      for (const m of targets) {
        try {
          const p = await manager.select(provider, m, reqOpts(config.detectTimeoutMs, extra), { capability: "complete" });
          results.push(await benchmarkOne(ctx, p, m, args, extra));
        } catch (err) {
          results.push({ model: m, error: err instanceof Error ? err.message : String(err) });
        }
      }
      results.sort((a, b) => {
        const ga = (a.genTokensPerSec as { median?: number } | undefined)?.median ?? -1;
        const gb = (b.genTokensPerSec as { median?: number } | undefined)?.median ?? -1;
        return gb - ga;
      });
      return ok({ results });
    }),
  );
}
