import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type Config } from "./config.js";
import { createHardwareProbe, type HardwareProbe } from "./hardware/index.js";
import { ProviderManager } from "./providers/manager.js";
import type { Provider } from "./providers/types.js";
import type { ToolContext } from "./tools/context.js";
import { registerAll } from "./tools/index.js";

// Read the version from package.json so the server reports the published
// version rather than a hardcoded literal that drifts on every release.
// dist/server.js lives at <pkg>/dist/, so ../package.json is the manifest.
export function readVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const SERVER_INSTRUCTIONS =
  "Local AI MCP manages local model runtimes. Start with list_providers / system_resources. " +
  "To offload work, prefer `delegate` (picks and readies the best local model) or `complete` with a specific model. " +
  "Inference never goes to a hosted API unless a hosted provider is named explicitly.";

/** Build a fully wired server (no transport). Used by the CLI entry point and tests. */
export function createServer(
  config: Config = loadConfig(process.env),
  deps: { hardware?: HardwareProbe; providers?: Provider[] } = {},
): { server: McpServer; ctx: ToolContext } {
  const manager = new ProviderManager(config, { providers: deps.providers });
  const ctx: ToolContext = { manager, hardware: deps.hardware ?? createHardwareProbe(), config };
  const server = new McpServer(
    { name: "local-ai-mcp", version: readVersion() },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAll(server, ctx);
  return { server, ctx };
}
