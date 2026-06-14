import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "./context.js";
import { aggregate, errMsg, fail, ok, removeModelGuarded } from "./helpers.js";

export function register(server: McpServer, ctx: ToolContext): void {
  const { manager, config } = ctx;

  server.tool(
    "pull_model",
    "HEAVY: Download/pull a model onto a provider. WARNING: this may download multiple gigabytes and can take a long time. Without a provider arg, attempts the pull on every detected provider.",
    {
      model: z.string().describe("Model id/name to pull (download)"),
      provider: z.enum(["ollama", "lmstudio"]).optional().describe("Optional provider id"),
    },
    async ({ model, provider }) => {
      try {
        const providers = await manager.resolve(provider, config.detectTimeoutMs);
        const byProvider = await aggregate(providers, (p) =>
          p.pull(model, config.pullTimeoutMs),
        );
        return ok({ pull: byProvider });
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  );

  server.tool(
    "remove_model",
    "DESTRUCTIVE: Permanently delete a model from a provider. Requires confirm:true; without it the action is refused. The provider argument is REQUIRED so a delete cannot fan out across every detected runtime.",
    {
      model: z.string().describe("Model id/name to remove"),
      confirm: z.boolean().describe("Must be true to perform this destructive deletion"),
      provider: z
        .enum(["ollama", "lmstudio"])
        .describe("Required provider id (delete is scoped to a single provider)"),
    },
    async ({ model, confirm, provider }) => {
      try {
        const providers = await manager.resolve(provider, config.detectTimeoutMs);
        const byProvider = await aggregate(providers, async (p) => {
          const guarded = await removeModelGuarded(confirm, model, () =>
            p.remove(model, config.requestTimeoutMs),
          );
          if (guarded.refused) {
            return { removed: false, refused: true, message: guarded.message };
          }
          return guarded.result;
        });
        return ok({ remove: byProvider });
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  );

  server.tool(
    "load_model",
    "Load a model into memory so it is ready for inference. Optionally set keepAlive (e.g. '5m', '1h'). Without a provider arg, loads on every detected provider.",
    {
      model: z.string().describe("Model id/name to load"),
      keepAlive: z.string().optional().describe("How long to keep the model resident, e.g. '5m'"),
      provider: z.enum(["ollama", "lmstudio"]).optional().describe("Optional provider id"),
    },
    async ({ model, keepAlive, provider }) => {
      try {
        const providers = await manager.resolve(provider, config.detectTimeoutMs);
        const byProvider = await aggregate(providers, (p) =>
          p.load(model, config.requestTimeoutMs, keepAlive),
        );
        return ok({ load: byProvider });
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  );

  server.tool(
    "unload_model",
    "Unload a model from memory to free VRAM/RAM. Without a provider arg, unloads from every detected provider.",
    {
      model: z.string().describe("Model id/name to unload"),
      provider: z.enum(["ollama", "lmstudio"]).optional().describe("Optional provider id"),
    },
    async ({ model, provider }) => {
      try {
        const providers = await manager.resolve(provider, config.detectTimeoutMs);
        const byProvider = await aggregate(providers, (p) =>
          p.unload(model, config.requestTimeoutMs),
        );
        return ok({ unload: byProvider });
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  );
}
