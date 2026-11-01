import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchHuggingFace } from "../catalog/huggingface.js";
import { CATALOG, CATALOG_TASKS, searchCatalog, type CatalogModel } from "../catalog/models.js";
import { computeFit, KV_CACHE_TYPES, type FitOutcome, type KvCacheType } from "../fit.js";
import type { SystemResources } from "../hardware/index.js";
import { sameModel } from "../providers/manager.js";
import type { ToolContext } from "./context.js";
import { anyRecord, type Extra, ok, reqOpts, safe } from "./helpers.js";

const TIER: Record<FitOutcome["target"], number> = { gpu: 0, partial: 1, cpu: 2, none: 3 };
const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

export interface Suggestion {
  name: string;
  family: string;
  parameterSize: string;
  quantization: string;
  approxSizeBytes: number;
  tasks: string[];
  fits: boolean;
  target: FitOutcome["target"];
  installed: string[];
  reason: string;
}

/**
 * Rank catalog models for a task. Within each fit tier (gpu, partial, cpu,
 * none) larger models come first as a proxy for capability; preferSpeed
 * flips that to smallest-first. Installed models win ties within a tier.
 */
export function rankSuggestions(
  resources: SystemResources,
  task: string,
  opts: {
    contextLength?: number;
    kvCacheType?: KvCacheType;
    preferSpeed?: boolean;
    installed?: Map<string, string[]>;
    catalog?: CatalogModel[];
  } = {},
): Suggestion[] {
  const catalog = opts.catalog ?? CATALOG;
  return catalog
    .filter((m) => m.tasks.includes(task))
    .map((m) => {
      const fit = computeFit(resources, m.approxSizeBytes, {
        parameterSize: m.parameterSize,
        contextLength: opts.contextLength,
        kvCacheType: opts.kvCacheType,
      });
      const installed = [...(opts.installed?.entries() ?? [])]
        .filter(([id]) => sameModel(id, m.name))
        .flatMap(([, providers]) => providers);
      const where =
        fit.target === "gpu"
          ? `fits fully in ${gb(fit.gpuAvailableBytes)} free VRAM`
          : fit.target === "partial"
            ? `~${Math.round((fit.gpuFraction ?? 0) * 100)}% on GPU, rest on CPU`
            : fit.target === "cpu"
              ? "CPU only (slower)"
              : "does not fit";
      return {
        name: m.name,
        family: m.family,
        parameterSize: m.parameterSize,
        quantization: m.quantization,
        approxSizeBytes: m.approxSizeBytes,
        tasks: m.tasks,
        fits: fit.fits,
        target: fit.target,
        installed,
        reason: `${m.parameterSize} ${task} model, ${where} at ${fit.contextLength}-token context${installed.length ? `; already installed on ${installed.join(", ")}` : ""}`,
      };
    })
    .sort((a, b) => {
      if (TIER[a.target] !== TIER[b.target]) return TIER[a.target] - TIER[b.target];
      const size = opts.preferSpeed ? a.approxSizeBytes - b.approxSizeBytes : b.approxSizeBytes - a.approxSizeBytes;
      if (size !== 0) return size;
      return (b.installed.length > 0 ? 1 : 0) - (a.installed.length > 0 ? 1 : 0);
    });
}

/** model id -> provider names, across live local providers. */
export async function installedModels(ctx: ToolContext, extra?: Extra): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const live = (await ctx.manager.detected(reqOpts(ctx.config.detectTimeoutMs, extra))).filter(
    (p) => p.kind === "local",
  );
  const opts = reqOpts(ctx.config.requestTimeoutMs, extra);
  await Promise.all(
    live.map(async (p) => {
      const models = await ctx.manager.listModelsCached(p, opts).catch(() => []);
      for (const m of models) out.set(m.id, [...(out.get(m.id) ?? []), p.name]);
    }),
  );
  return out;
}

export function register(server: McpServer, ctx: ToolContext): void {
  const { hardware, config } = ctx;

  server.registerTool(
    "search_available",
    {
      title: "Search catalog",
      description:
        "Search the built-in curated catalog of well-known local models (Ollama tags) by name, family, or task. Offline and instant. For live results with per-quant fit, use search_models with source 'huggingface'.",
      inputSchema: { query: z.string().describe("Search text matched against model name, family, and tasks") },
      outputSchema: { query: z.string(), note: z.string(), results: z.array(anyRecord) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ query }) =>
      ok({
        query,
        note: "Curated static catalog. Use search_models (source: huggingface) for live GGUF search.",
        results: searchCatalog(query).map((m) => ({ ...m })),
      }),
    ),
  );

  server.registerTool(
    "suggest_model",
    {
      title: "Suggest model",
      description:
        "Recommend catalog models for a task, ranked for THIS machine: fully-on-GPU first, then partial GPU offload, then CPU-only. Within a tier the largest (most capable) model comes first unless preferSpeed is true. Flags models already installed on a live provider and explains each pick.",
      inputSchema: {
        task: z.enum(CATALOG_TASKS).describe("The task you want a model for"),
        contextLength: z.number().int().positive().optional().describe("Context length to plan for (default 4096)"),
        kvCacheType: z.enum(KV_CACHE_TYPES).optional().describe("KV cache precision (default f16)"),
        preferSpeed: z.boolean().optional().describe("Prefer smaller, faster models within each tier"),
      },
      outputSchema: { task: z.string(), suggestions: z.array(anyRecord) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ task, contextLength, kvCacheType, preferSpeed }, extra) => {
      const [resources, installed] = await Promise.all([
        hardware.getSystemResources(),
        installedModels(ctx, extra).catch(() => new Map<string, string[]>()),
      ]);
      return ok({
        task,
        suggestions: rankSuggestions(resources, task, { contextLength, kvCacheType, preferSpeed, installed }),
      });
    }),
  );

  server.registerTool(
    "search_models",
    {
      title: "Search models (live)",
      description:
        "Find models to download, annotated with whether each fits this machine. source 'huggingface' searches GGUF repos on the Hugging Face Hub and returns per-quant sizes, the best quant for this hardware, and pullable references (Ollama: hf.co/<repo>:<quant>). source 'catalog' searches the offline curated list. The Ollama library has no public search API, so it is not a source.",
      inputSchema: {
        query: z.string().describe("Search text, e.g. 'qwen coder' or 'gemma 3'"),
        source: z.enum(["huggingface", "catalog"]).optional().describe("Default huggingface"),
        task: z.enum(CATALOG_TASKS).optional().describe("Catalog source only: filter by task"),
        fitsOnly: z.boolean().optional().describe("Only return results with a quant that fits"),
        contextLength: z.number().int().positive().optional().describe("Context length for fit (default 4096)"),
        limit: z.number().int().min(1).max(20).optional().describe("Max repos (default 8)"),
      },
      outputSchema: { source: z.string(), query: z.string(), results: z.array(anyRecord) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ query, source, task, fitsOnly, contextLength, limit }, extra) => {
      const resources = await hardware.getSystemResources();
      const src = source ?? "huggingface";
      if (src === "catalog") {
        let results = searchCatalog(query)
          .filter((m) => !task || m.tasks.includes(task))
          .map((m) => {
            const f = computeFit(resources, m.approxSizeBytes, { parameterSize: m.parameterSize, contextLength });
            return { ...m, fits: f.fits, target: f.target };
          });
        if (fitsOnly) results = results.filter((r) => r.fits);
        return ok({ source: src, query, results });
      }
      if (!config.allowNetworkSearch) {
        throw new Error("Network search is disabled (LOCAL_AI_DISABLE_NETWORK_SEARCH). Use source 'catalog'.");
      }
      let results = await searchHuggingFace(query, resources, {
        limit: limit ?? 8,
        contextLength,
        timeoutMs: Math.max(config.requestTimeoutMs, 15000),
        signal: extra?.signal,
      });
      if (fitsOnly) results = results.filter((r) => r.best !== undefined);
      return ok({ source: src, query, results });
    }),
  );
}
