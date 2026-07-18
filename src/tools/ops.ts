import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CATALOG } from "../catalog/models.js";
import type { ToolContext } from "./context.js";
import { aggregate, computeFit, errMsg, fail, ok } from "./helpers.js";

/**
 * Resolve the on-disk byte size for a model: explicit sizeBytes wins, then a
 * provider's listModels entry, then the static catalog. Returns undefined if
 * unknown. Also returns parameterSize when available (for KV-cache estimates).
 */
export async function resolveModelSizeBytes(
  ctx: ToolContext,
  model: string,
  explicitSizeBytes: number | undefined,
  providerArg: string | undefined,
): Promise<{
  requiredBytes: number | undefined;
  source: string;
  parameterSize?: string;
}> {
  if (typeof explicitSizeBytes === "number" && explicitSizeBytes > 0) {
    return { requiredBytes: explicitSizeBytes, source: "explicit" };
  }
  try {
    const providers = await ctx.manager.resolve(providerArg, ctx.config.detectTimeoutMs);
    for (const p of providers) {
      const models = await p.listModels(ctx.config.requestTimeoutMs).catch(() => []);
      const match = models.find((m) => m.id === model);
      if (match && typeof match.sizeBytes === "number" && match.sizeBytes > 0) {
        return {
          requiredBytes: match.sizeBytes,
          source: `provider:${p.id}`,
          parameterSize: match.parameterSize,
        };
      }
    }
  } catch {
    // ignore detection/listing failures and fall back to catalog
  }
  const cat = CATALOG.find((c) => c.name === model);
  if (cat) {
    return {
      requiredBytes: cat.approxSizeBytes,
      source: "catalog",
      parameterSize: cat.parameterSize,
    };
  }
  return { requiredBytes: undefined, source: "unknown" };
}

export function register(server: McpServer, ctx: ToolContext): void {
  const { manager, hardware, config } = ctx;

  server.tool(
    "health_check",
    "Check whether each provider's local runtime is reachable and report its version. Without a provider arg, checks all configured providers.",
    { provider: z.enum(["ollama", "lmstudio", "moonshot"]).optional().describe("Optional provider id") },
    async ({ provider }) => {
      try {
        const targets = provider ? [manager.get(provider)].filter(Boolean) : manager.providers;
        if (provider && targets.length === 0) {
          return fail(`Unknown provider: ${provider}`);
        }
        const byProvider = await aggregate(
          targets as NonNullable<(typeof targets)[number]>[],
          (p) => p.health(config.detectTimeoutMs),
        );
        return ok({ health: byProvider });
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  );

  server.tool(
    "system_resources",
    "Report local hardware resources: platform, total/free RAM, CPU count, and detected GPUs with VRAM. Used to reason about which models can run locally.",
    {},
    async () => {
      try {
        const resources = await hardware.getSystemResources();
        return ok(resources);
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  );

  server.tool(
    "fit_check",
    "Determine whether a model fits on the local hardware. Resolves the model weight size from the provider or the static catalog (or an explicit sizeBytes), estimates KV-cache overhead for a context length (default 4096), then compares weight+KV against free GPU VRAM, falling back to system RAM. Returns fits, target (gpu/cpu/none), weight/kv/required/available bytes.",
    {
      model: z.string().describe("Model id/name to check"),
      sizeBytes: z
        .number()
        .optional()
        .describe("Optional explicit model weight size in bytes (overrides lookup)"),
      contextLength: z
        .number()
        .optional()
        .describe("Context length for KV-cache estimate (default 4096)"),
      parameterSize: z
        .string()
        .optional()
        .describe('Optional parameter size like "7B" or "3.8B" for KV estimate (overrides lookup)'),
      provider: z.enum(["ollama", "lmstudio", "moonshot"]).optional().describe("Optional provider id"),
    },
    async ({ model, sizeBytes, contextLength, parameterSize, provider }) => {
      try {
        const resolved = await resolveModelSizeBytes(ctx, model, sizeBytes, provider);
        if (resolved.requiredBytes === undefined) {
          return fail(
            `Could not determine size for "${model}" from provider or catalog. Pass sizeBytes to check fit explicitly.`,
          );
        }
        const resources = await hardware.getSystemResources();
        const outcome = computeFit(resources, resolved.requiredBytes, {
          contextLength,
          parameterSize: parameterSize ?? resolved.parameterSize,
        });
        return ok({ model, sizeSource: resolved.source, ...outcome });
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  );

  server.tool(
    "benchmark",
    "HEAVY: Runs REAL inference. Executes one small completion against a loaded/loadable model and measures latency (ms) and throughput (tokens/sec). This consumes compute and may load the model. Without a provider arg, runs on the first detected provider.",
    {
      model: z.string().describe("Model id/name to benchmark"),
      prompt: z.string().optional().describe("Optional prompt; a short default is used otherwise"),
      maxTokens: z.number().optional().describe("Max tokens to generate (default 64)"),
      provider: z.enum(["ollama", "lmstudio", "moonshot"]).optional().describe("Optional provider id"),
    },
    async ({ model, prompt, maxTokens, provider }) => {
      try {
        const providers = await manager.resolve(provider, config.detectTimeoutMs);
        if (providers.length === 0) {
          return fail("No live providers detected to benchmark against.");
        }
        const p = providers[0];
        const max = typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 64;
        const start = Date.now();
        const result = await p.complete(
          {
            model,
            prompt: prompt ?? "Write one short sentence about local AI.",
            maxTokens: max,
          },
          config.requestTimeoutMs,
        );
        const latencyMs = Date.now() - start;
        const completionTokens =
          result.completionTokens ?? Math.max(1, Math.round(result.text.length / 4));
        const tokensPerSec = latencyMs > 0 ? (completionTokens / latencyMs) * 1000 : 0;
        return ok({
          provider: p.id,
          model,
          latencyMs,
          completionTokens,
          tokensPerSec: Number(tokensPerSec.toFixed(2)),
          maxTokens: max,
        });
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  );
}
