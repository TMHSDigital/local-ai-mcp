import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "./context.js";
import { reqOpts } from "./helpers.js";

export const RESOURCE_URIS = {
  system: "local-ai://system",
  loaded: "local-ai://loaded",
  models: "local-ai://models/{provider}",
} as const;

const json = (uri: string, data: unknown) => ({
  contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
});

/**
 * Resources give clients live context without tool calls; prompts give users
 * discoverable entry points. Subscribers to local-ai://loaded are notified
 * whenever a tool changes what is loaded.
 */
export function registerResourcesAndPrompts(server: McpServer, ctx: ToolContext): () => void {
  const { manager, config, hardware } = ctx;
  const subscribed = new Set<string>();

  server.registerResource(
    "system",
    RESOURCE_URIS.system,
    { title: "System resources", description: "RAM, CPU and GPU/VRAM snapshot", mimeType: "application/json" },
    async (uri) => json(uri.href, await hardware.getSystemResources()),
  );

  server.registerResource(
    "loaded",
    RESOURCE_URIS.loaded,
    { title: "Loaded models", description: "Models resident in memory on each live provider", mimeType: "application/json" },
    async (uri) => {
      const providers = await manager.detected(reqOpts(config.detectTimeoutMs));
      const opts = reqOpts(config.requestTimeoutMs);
      const entries = await Promise.all(
        providers.map(async (p) => [p.name, await p.listLoaded(opts).catch((e: Error) => ({ error: e.message }))] as const),
      );
      return json(uri.href, Object.fromEntries(entries));
    },
  );

  server.registerResource(
    "models",
    new ResourceTemplate(RESOURCE_URIS.models, {
      list: async () => ({
        resources: manager.providers.map((p) => ({
          uri: `local-ai://models/${p.name}`,
          name: `models-${p.name}`,
          title: `Models on ${p.name}`,
          mimeType: "application/json",
        })),
      }),
      complete: { provider: () => manager.names() },
    }),
    { title: "Installed models", description: "Models installed on one provider", mimeType: "application/json" },
    async (uri, vars) => {
      const name = String(vars.provider);
      const p = manager.require(name);
      return json(uri.href, await manager.listModelsCached(p, reqOpts(config.requestTimeoutMs)));
    },
  );

  // Minimal subscription support so clients can watch local-ai://loaded.
  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subscribed.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscribed.delete(req.params.uri);
    return {};
  });

  const text = (t: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: t } }] });

  server.registerPrompt(
    "setup",
    {
      title: "Set up local AI",
      description: "Detect runtimes and hardware, then recommend (and optionally install) a starter model that fits",
      argsSchema: { task: z.string().optional().describe("What you mainly want a model for (chat, code, ...)") },
    },
    ({ task }) =>
      text(
        `Help me set up local AI on this machine. 1) Call list_providers and system_resources and summarise what is running and how much GPU/RAM I have. ` +
          `2) Call suggest_model for task "${task ?? "chat"}" and recommend the best option that fits fully on my GPU, noting anything already installed. ` +
          `3) Ask me before downloading anything; if I agree, use ensure_model with allowPull:true. 4) Finish with a one-line test via complete.`,
      ),
  );

  server.registerPrompt(
    "free-vram",
    { title: "Free up VRAM", description: "See what is loaded and unload what is not needed" },
    () =>
      text(
        "Call list_loaded and system_resources. Show me each loaded model with its VRAM use, then ask which to unload and use unload_model for the ones I pick.",
      ),
  );

  server.registerPrompt(
    "benchmark-my-models",
    {
      title: "Benchmark my models",
      description: "Compare the speed of installed models on this machine",
      argsSchema: { task: z.string().optional().describe("Only compare models suited to this task") },
    },
    ({ task }) =>
      text(
        `Call list_models, pick up to 4 installed${task ? ` ${task}` : ""} models (skip embedding models), and run benchmark with models:[...] and runs:3. ` +
          "Present a table of generation tokens/sec and time-to-first-token, and recommend one.",
      ),
  );

  server.registerPrompt(
    "pick-model",
    {
      title: "Pick a model for a task",
      description: "Find the best model for a task on this hardware",
      argsSchema: { task: z.string().describe("Task, e.g. code, chat, vision, reasoning") },
    },
    ({ task }) =>
      text(
        `Find the best model for "${task}" on this machine. Use suggest_model, and search_models with source huggingface for newer options. ` +
          "Explain the trade-offs (fits on GPU vs partial offload) and recommend one.",
      ),
  );

  return () => {
    if (subscribed.has(RESOURCE_URIS.loaded)) {
      void server.server.sendResourceUpdated({ uri: RESOURCE_URIS.loaded }).catch(() => undefined);
    }
  };
}
