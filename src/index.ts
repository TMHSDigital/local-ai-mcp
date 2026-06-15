#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createHardwareProbe } from "./hardware/index.js";
import { ProviderManager } from "./providers/manager.js";
import type { ToolContext } from "./tools/context.js";
import { registerAll } from "./tools/index.js";

// Read the version from package.json so the server reports the published
// version rather than a hardcoded literal that drifts on every release.
// dist/index.js lives at <pkg>/dist/, so ../package.json is the manifest
// (npm always includes package.json in the published tarball).
function readVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const manager = new ProviderManager(config);
  const hardware = createHardwareProbe();
  const ctx: ToolContext = { manager, hardware, config };

  const server = new McpServer({ name: "local-ai-mcp", version: readVersion() });
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
