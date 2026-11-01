import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Provider } from "../providers/types.js";
import type { ToolContext } from "./context.js";
import { aggregate, ok, perProvider, providerArg, reqOpts, safe } from "./helpers.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function register(server: McpServer, ctx: ToolContext): void {
  const { manager, config } = ctx;

  server.registerTool(
    "list_providers",
    {
      title: "List providers",
      description:
        "List configured model runtimes (Ollama, LM Studio, llama.cpp, Docker Model Runner, and any opt-in MLX / vLLM / Foundry Local / OpenAI-compatible / hosted instances) with host, kind (local or hosted), live status, and capabilities.",
      inputSchema: { provider: providerArg(ctx).optional() },
      outputSchema: { providers: z.array(z.record(z.string(), z.unknown())) },
      annotations: READ_ONLY,
    },
    safe(async ({ provider }, extra) => {
      const targets: Provider[] = provider ? [manager.require(provider)] : manager.providers;
      // Explicit status request: bypass the detection cache.
      for (const p of targets) manager.invalidate(p.name);
      const opts = reqOpts(config.detectTimeoutMs, extra);
      const providers = await Promise.all(
        targets.map(async (p) => ({
          provider: p.name,
          type: p.type,
          kind: p.kind,
          host: p.host,
          live: await manager.isLive(p, opts),
          capabilities: p.capabilities(),
        })),
      );
      return ok({ providers });
    }),
  );

  server.registerTool(
    "list_models",
    {
      title: "List installed models",
      description:
        "List models installed/available on each live provider, keyed by provider. Pass provider to query just one.",
      inputSchema: { provider: providerArg(ctx).optional() },
      outputSchema: { models: perProvider },
      annotations: READ_ONLY,
    },
    safe(async ({ provider }, extra) => {
      const providers = await manager.resolve(provider, reqOpts(config.detectTimeoutMs, extra));
      const opts = reqOpts(config.requestTimeoutMs, extra);
      const models = await aggregate(ctx, providers, async (p) => {
        manager.invalidate(p.name);
        return manager.listModelsCached(p, opts);
      });
      return ok({ models });
    }),
  );

  server.registerTool(
    "list_loaded",
    {
      title: "List loaded models",
      description:
        "List models currently loaded into memory on each live provider, with VRAM use and context length where the runtime reports them.",
      inputSchema: { provider: providerArg(ctx).optional() },
      outputSchema: { loaded: perProvider },
      annotations: READ_ONLY,
    },
    safe(async ({ provider }, extra) => {
      const providers = await manager.resolve(provider, reqOpts(config.detectTimeoutMs, extra));
      const opts = reqOpts(config.requestTimeoutMs, extra);
      const loaded = await aggregate(ctx, providers, (p) => p.listLoaded(opts));
      return ok({ loaded });
    }),
  );

  server.registerTool(
    "model_info",
    {
      title: "Model info",
      description:
        "Detailed metadata for one model (family, parameter size, quantization, context length, and layer architecture where available). Without provider, queries the live local providers that have the model.",
      inputSchema: {
        model: z.string().describe("Model id/name to inspect"),
        provider: providerArg(ctx).optional(),
      },
      outputSchema: { model: z.string(), info: perProvider },
      annotations: READ_ONLY,
    },
    safe(async ({ model, provider }, extra) => {
      const detectOpts = reqOpts(config.detectTimeoutMs, extra);
      const opts = reqOpts(config.requestTimeoutMs, extra);
      let targets: Provider[];
      if (provider) {
        targets = [manager.require(provider)];
      } else {
        const live = (await manager.detected(detectOpts)).filter(
          (p) => p.kind === "local" || config.allowHostedFallback,
        );
        targets = await manager.locate(model, live, opts);
        if (targets.length === 0) {
          throw new Error(
            `Model "${model}" was not found on any live local provider. Check list_models, or pass provider.`,
          );
        }
      }
      const info = await aggregate(ctx, targets, (p) => p.modelInfo(model, opts));
      return ok({ model, info });
    }),
  );
}
