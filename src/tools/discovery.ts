import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { providerIdZod } from "./provider-id.js";
import type { ToolContext } from "./context.js";
import { aggregate, errMsg, fail, ok } from "./helpers.js";

export function register(server: McpServer, ctx: ToolContext): void {
  const { manager, config } = ctx;

  server.tool(
    "list_providers",
    "List the configured model runtime providers (Ollama, LM Studio, llama.cpp, optional OpenAI-compat / Moonshot) with their host, whether they are detected/live, and their capabilities. Optionally filter to a single provider.",
    { provider: providerIdZod.optional().describe("Optional provider id to filter to") },
    async ({ provider }) => {
      try {
        const targets = provider ? [manager.get(provider)].filter(Boolean) : manager.providers;
        if (provider && targets.length === 0) {
          return fail(`Unknown provider: ${provider}`);
        }
        const results = await Promise.all(
          (targets as NonNullable<(typeof targets)[number]>[]).map(async (p) => {
            const live = await p.detect(config.detectTimeoutMs).catch(() => false);
            return {
              provider: p.id,
              host: p.host,
              detected: live,
              live,
              capabilities: p.capabilities(),
            };
          }),
        );
        return ok({ providers: results });
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  );

  server.tool(
    "list_models",
    "List models installed/available on each detected provider. Without a provider arg, aggregates across all detected providers keyed by provider.",
    { provider: providerIdZod.optional().describe("Optional provider id") },
    async ({ provider }) => {
      try {
        const providers = await manager.resolve(provider, config.detectTimeoutMs);
        const byProvider = await aggregate(providers, (p) => p.listModels(config.requestTimeoutMs));
        return ok({ models: byProvider });
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  );

  server.tool(
    "list_loaded",
    "List models currently loaded into memory on each detected provider. Without a provider arg, aggregates across all detected providers keyed by provider.",
    { provider: providerIdZod.optional().describe("Optional provider id") },
    async ({ provider }) => {
      try {
        const providers = await manager.resolve(provider, config.detectTimeoutMs);
        const byProvider = await aggregate(providers, (p) => p.listLoaded(config.requestTimeoutMs));
        return ok({ loaded: byProvider });
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  );

  server.tool(
    "model_info",
    "Show detailed metadata for a specific model (family, parameter size, quantization, context length). Without a provider arg, queries all detected providers.",
    {
      model: z.string().describe("Model id/name to inspect"),
      provider: providerIdZod.optional().describe("Optional provider id"),
    },
    async ({ model, provider }) => {
      try {
        const providers = await manager.resolve(provider, config.detectTimeoutMs);
        const byProvider = await aggregate(providers, (p) =>
          p.modelInfo(model, config.requestTimeoutMs),
        );
        return ok({ model, info: byProvider });
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  );
}
