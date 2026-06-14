#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createHardwareProbe } from "./hardware/index.js";
import { ProviderManager } from "./providers/manager.js";
import type { ToolContext } from "./tools/context.js";
import { registerAll } from "./tools/index.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const manager = new ProviderManager(config);
  const hardware = createHardwareProbe();
  const ctx: ToolContext = { manager, hardware, config };

  const server = new McpServer({ name: "local-ai-mcp", version: "0.1.0" });
  registerAll(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout is the MCP channel; all logs must go to stderr only.
  process.stderr.write(
    `local-ai-mcp ready (ollama=${config.ollamaHost}, lmstudio=${config.lmstudioHost})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`local-ai-mcp fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
