import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CATALOG, searchCatalog } from "../catalog/models.js";
import { computeFit, errMsg, fail, ok } from "./helpers.js";
import type { ToolContext } from "./context.js";

const TASKS = ["chat", "code", "embed", "vision", "reasoning", "general"] as const;

export function register(server: McpServer, ctx: ToolContext): void {
  const { hardware } = ctx;

  server.tool(
    "search_available",
    "Search the built-in catalog of well-known local models by name, family, or task. Note: this searches a curated static catalog, not the full live Ollama library (https://ollama.com/library).",
    { query: z.string().describe("Search text matched against model name, family, and tasks") },
    async ({ query }) => {
      try {
        const matches = searchCatalog(query).map((m) => ({ ...m }));
        return ok({
          query,
          note: "Curated static catalog. For the full set, browse the Ollama library.",
          results: matches,
        });
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  );

  server.tool(
    "suggest_model",
    "Recommend local models for a task (chat/code/embed/vision/reasoning/general), ranked by task match and then by whether they fit the detected free GPU VRAM or system RAM. Returns a ranked list with fit flags.",
    {
      task: z.enum(TASKS).describe("The task you want a model for"),
    },
    async ({ task }) => {
      try {
        const resources = await hardware.getSystemResources();
        const ranked = CATALOG.map((m) => {
          const taskMatch = m.tasks.includes(task);
          const fit = computeFit(resources, m.approxSizeBytes);
          return {
            name: m.name,
            family: m.family,
            parameterSize: m.parameterSize,
            quantization: m.quantization,
            approxSizeBytes: m.approxSizeBytes,
            tasks: m.tasks,
            taskMatch,
            fits: fit.fits,
            fitTarget: fit.target,
          };
        })
          .sort((a, b) => {
            if (a.taskMatch !== b.taskMatch) return a.taskMatch ? -1 : 1;
            if (a.fits !== b.fits) return a.fits ? -1 : 1;
            return a.approxSizeBytes - b.approxSizeBytes;
          })
          .filter((m) => m.taskMatch);
        return ok({ task, suggestions: ranked });
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  );
}
