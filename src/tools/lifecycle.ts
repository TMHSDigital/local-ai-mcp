import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computeFit, KV_CACHE_TYPES, type FitOutcome, type KvCacheType } from "../fit.js";
import { sameModel } from "../providers/manager.js";
import type { LoadedModelInfo, Provider, PullProgress, RequestOptions } from "../providers/types.js";
import type { ToolContext } from "./context.js";
import { anyRecord, type Extra, ok, progressSender, providerArg, reqOpts, safe } from "./helpers.js";
import { sizeModel } from "./sizing.js";

/** Forward provider pull progress as MCP progress notifications. */
function pullProgress(extra: Extra | undefined) {
  const send = progressSender(extra);
  if (!send) return undefined;
  let tick = 0;
  return async (p: PullProgress) => {
    if (p.completed !== undefined && p.total !== undefined && p.total > 0) {
      await send(p.completed, p.total, p.status);
    } else {
      tick += 1;
      await send(tick, undefined, p.status);
    }
  };
}

export type ConfirmOutcome = { confirmed: true; via: "elicitation" | "argument" } | { confirmed: false; message: string };

/**
 * Destructive-action gate for remove_model. When the client supports
 * elicitation, the *user* is asked directly (the model's confirm argument is
 * not enough). Otherwise falls back to requiring confirm:true.
 */
export async function confirmRemoval(
  ctx: ToolContext,
  confirm: boolean | undefined,
  model: string,
  providerName: string,
): Promise<ConfirmOutcome> {
  const server = ctx.server;
  if (server?.getClientCapabilities()?.elicitation) {
    const res = await server.elicitInput({
      message: `Permanently delete model "${model}" from ${providerName}? It will have to be downloaded again to use it.`,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: "Delete permanently",
            description: `Delete ${model} from ${providerName}`,
          },
        },
        required: ["confirm"],
      },
    });
    if (res.action === "accept" && res.content?.confirm === true) {
      return { confirmed: true, via: "elicitation" };
    }
    return { confirmed: false, message: `User declined deleting "${model}" from ${providerName}.` };
  }
  if (confirm === true) return { confirmed: true, via: "argument" };
  return {
    confirmed: false,
    message: `Refusing to remove "${model}": this is a destructive action. Pass confirm:true to proceed.`,
  };
}

export type EvictPolicy = "none" | "lru" | "all";

/**
 * Choose loaded models to unload so `model` fits on the GPU. LRU order uses
 * expiresAt (Ollama renews keep-alive on use, so the earliest expiry is the
 * least recently used). Returns undefined when no eviction set makes it fit.
 */
export function planEviction(
  fitWith: (extraVram: number) => FitOutcome,
  loaded: LoadedModelInfo[],
  policy: EvictPolicy,
): { evict: LoadedModelInfo[]; fit: FitOutcome } | undefined {
  if (policy === "none") return undefined;
  const ordered = [...loaded].sort((a, b) => {
    const ta = a.expiresAt ? Date.parse(a.expiresAt) : 0;
    const tb = b.expiresAt ? Date.parse(b.expiresAt) : 0;
    return ta - tb;
  });
  if (policy === "all") {
    const freed = ordered.reduce((s, m) => s + (m.sizeVramBytes ?? 0), 0);
    const fit = fitWith(freed);
    return fit.target === "gpu" ? { evict: ordered, fit } : undefined;
  }
  const evict: LoadedModelInfo[] = [];
  let freed = 0;
  for (const m of ordered) {
    evict.push(m);
    freed += m.sizeVramBytes ?? 0;
    const fit = fitWith(freed);
    if (fit.target === "gpu") return { evict, fit };
  }
  return undefined;
}

export function register(server: McpServer, ctx: ToolContext): void {
  const { manager, config } = ctx;
  const changed = () => ctx.onStateChange?.();

  server.registerTool(
    "pull_model",
    {
      title: "Pull model",
      description:
        "HEAVY: Download a model onto ONE provider (multiple GB, can take a long time). Streams download progress via MCP progress notifications when the client sends a progressToken. Without provider, uses the provider that already has the model, else the first live local provider that can pull.",
      inputSchema: {
        model: z.string().describe("Model id/name to pull (e.g. qwen3:8b, hf.co/<repo>:<quant>)"),
        provider: providerArg(ctx).optional(),
      },
      outputSchema: { pull: anyRecord },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ model, provider }, extra) => {
      const p = await manager.select(provider, model, reqOpts(config.detectTimeoutMs, extra), {
        capability: "pull",
        allowMissing: true,
      });
      const result = await p.pull(model, {
        ...reqOpts(config.pullTimeoutMs, extra),
        onProgress: pullProgress(extra),
      });
      manager.invalidate(p.name);
      changed();
      return ok({ pull: result });
    }),
  );

  server.registerTool(
    "remove_model",
    {
      title: "Remove model",
      description:
        "DESTRUCTIVE: Permanently delete a model from one provider. provider is REQUIRED (no fan-out). If the client supports elicitation the user is asked to confirm directly; otherwise confirm:true is required.",
      inputSchema: {
        model: z.string().describe("Model id/name to remove"),
        provider: providerArg(ctx, "Provider to delete from (required)"),
        confirm: z
          .boolean()
          .optional()
          .describe("Must be true when the client cannot ask the user directly (no elicitation support)"),
      },
      outputSchema: { remove: anyRecord },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ model, confirm, provider }, extra) => {
      const p = manager.require(provider);
      if (!p.capabilities().remove) {
        throw new Error(`${p.name} does not support remove`);
      }
      const gate = await confirmRemoval(ctx, confirm, model, p.name);
      if (!gate.confirmed) {
        return ok({ remove: { provider: p.name, model, removed: false, refused: true, message: gate.message } });
      }
      const result = await p.remove(model, reqOpts(config.requestTimeoutMs, extra));
      manager.invalidate(p.name);
      changed();
      return ok({ remove: { ...result, confirmedVia: gate.via } });
    }),
  );

  server.registerTool(
    "load_model",
    {
      title: "Load model",
      description:
        "Load a model into memory on ONE provider so it is ready for inference. Optional keepAlive (e.g. '5m', '1h') and contextLength. Without provider, uses the live local provider that has the model.",
      inputSchema: {
        model: z.string().describe("Model id/name to load"),
        keepAlive: z.string().optional().describe("How long to keep the model resident, e.g. '5m'"),
        contextLength: z.number().int().positive().optional().describe("Context window to load with (Ollama num_ctx, LM Studio --context-length)"),
        provider: providerArg(ctx).optional(),
      },
      outputSchema: { load: anyRecord },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ model, keepAlive, contextLength, provider }, extra) => {
      const p = await manager.select(provider, model, reqOpts(config.detectTimeoutMs, extra), { capability: "load" });
      const result = await p.load(model, { ...reqOpts(config.requestTimeoutMs, extra), keepAlive, contextLength });
      changed();
      return ok({ load: result });
    }),
  );

  server.registerTool(
    "unload_model",
    {
      title: "Unload model",
      description:
        "Unload a model from memory to free VRAM/RAM on ONE provider. Without provider, uses the live local provider that has it loaded.",
      inputSchema: {
        model: z.string().describe("Model id/name to unload"),
        provider: providerArg(ctx).optional(),
      },
      outputSchema: { unload: anyRecord },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ model, provider }, extra) => {
      const p = await manager.select(provider, model, reqOpts(config.detectTimeoutMs, extra), { capability: "unload" });
      const result = await p.unload(model, reqOpts(config.requestTimeoutMs, extra));
      changed();
      return ok({ unload: result });
    }),
  );

  server.registerTool(
    "ensure_model",
    {
      title: "Ensure model is ready",
      description:
        "Make a model ready in one call: optionally pull it, check it fits current free VRAM, unload other models if needed (evict: 'lru' or 'all'), load it, and verify. Use dryRun:true to get the plan without changing anything.",
      inputSchema: {
        model: z.string().describe("Model id/name"),
        provider: providerArg(ctx).optional(),
        contextLength: z.number().int().positive().optional().describe("Context window to fit and load with (default 4096)"),
        kvCacheType: z.enum(KV_CACHE_TYPES).optional().describe("KV cache precision used for the fit estimate (default f16)"),
        allowPull: z.boolean().optional().describe("Download the model if it is not installed (default false)"),
        evict: z
          .enum(["none", "lru", "all"])
          .optional()
          .describe("Unload other models to make room: none (default), lru (least recently used first), all"),
        keepAlive: z.string().optional().describe("Keep-alive for the loaded model, e.g. '30m'"),
        dryRun: z.boolean().optional().describe("Return the plan only (default false)"),
      },
      outputSchema: {
        ready: z.boolean(),
        provider: z.string(),
        model: z.string(),
        plan: z.array(z.string()),
        fit: anyRecord.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async (args, extra) => {
      return ok(await ensureModel(ctx, args, extra));
    }),
  );
}

export interface EnsureArgs {
  model: string;
  provider?: string;
  contextLength?: number;
  kvCacheType?: KvCacheType;
  allowPull?: boolean;
  evict?: EvictPolicy;
  keepAlive?: string;
  dryRun?: boolean;
}

export async function ensureModel(
  ctx: ToolContext,
  args: EnsureArgs,
  extra?: Extra,
): Promise<{
  ready: boolean;
  provider: string;
  model: string;
  plan: string[];
  dryRun?: boolean;
  alreadyLoaded?: boolean;
  evicted?: string[];
  fit?: FitOutcome;
  loadMs?: number;
  detail?: string;
}> {
  const { manager, config } = ctx;
  const opts: RequestOptions = reqOpts(config.requestTimeoutMs, extra);
  const p: Provider = await manager.select(args.provider, args.model, reqOpts(config.detectTimeoutMs, extra), {
    capability: args.allowPull ? "pull" : "complete",
    // Resolve a provider even when the model is missing so the error below can
    // say exactly what to do (allowPull) rather than "not found".
    allowMissing: true,
  });
  const caps = p.capabilities();
  const plan: string[] = [];
  const installed = (await manager.locate(args.model, [p], opts)).length > 0;

  if (!installed) {
    if (!args.allowPull) {
      throw new Error(`"${args.model}" is not installed on ${p.name}. Pass allowPull:true to download it.`);
    }
    if (!caps.pull) throw new Error(`${p.name} cannot pull models`);
    plan.push(`pull ${args.model} on ${p.name}`);
  }

  const loadedNow = await p.listLoaded(opts).catch(() => [] as LoadedModelInfo[]);
  if (installed && loadedNow.some((m) => sameModel(m.id, args.model))) {
    return { ready: true, provider: p.name, model: args.model, plan: ["already loaded"], alreadyLoaded: true };
  }

  const sizing = await sizeModel(ctx, installed ? p : undefined, args.model, opts);
  const resources = await ctx.hardware.getSystemResources();
  const fitWith = (extraVram: number) =>
    computeFit(resources, sizing.weightBytes ?? 0, {
      contextLength: args.contextLength,
      parameterSize: sizing.parameterSize,
      architecture: sizing.architecture,
      kvCacheType: args.kvCacheType,
      residentVramBytes: extraVram,
    });
  let fit: FitOutcome | undefined = sizing.weightBytes ? fitWith(0) : undefined;
  let evict: LoadedModelInfo[] = [];

  if (fit && fit.target !== "gpu" && caps.unload) {
    const others = loadedNow.filter((m) => !sameModel(m.id, args.model));
    const planned = planEviction(fitWith, others, args.evict ?? "none");
    if (planned) {
      evict = planned.evict;
      fit = planned.fit;
      for (const m of evict) plan.push(`unload ${m.id} (frees ~${((m.sizeVramBytes ?? 0) / 1024 ** 3).toFixed(1)} GB VRAM)`);
    }
  }
  if (fit && !fit.fits) {
    throw new Error(`"${args.model}" does not fit: ${fit.note}`);
  }
  if (caps.load) plan.push(`load ${args.model} on ${p.name}${args.contextLength ? ` with context ${args.contextLength}` : ""}`);
  else plan.push(`${p.name} loads models on first request; nothing to load`);
  if (fit && fit.target !== "gpu") plan.push(`note: ${fit.note}`);

  if (args.dryRun) {
    return { ready: false, dryRun: true, provider: p.name, model: args.model, plan, ...(fit ? { fit } : {}) };
  }

  if (!installed) {
    await p.pull(args.model, { ...reqOpts(config.pullTimeoutMs, extra), onProgress: pullProgress(extra) });
    manager.invalidate(p.name);
  }
  for (const m of evict) await p.unload(m.id, opts);
  const start = Date.now();
  let detail: string | undefined;
  if (caps.load) {
    const res = await p.load(args.model, { ...opts, keepAlive: args.keepAlive, contextLength: args.contextLength });
    detail = res.detail;
  }
  const loadMs = Date.now() - start;
  ctx.onStateChange?.();
  const verify = caps.load ? await p.listLoaded(opts).catch(() => [] as LoadedModelInfo[]) : [];
  const ready = !caps.load || verify.length === 0 || verify.some((m) => sameModel(m.id, args.model));
  return {
    ready,
    provider: p.name,
    model: args.model,
    plan,
    evicted: evict.map((m) => m.id),
    ...(fit ? { fit } : {}),
    loadMs,
    ...(detail ? { detail } : {}),
  };
}
