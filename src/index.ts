#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const { server } = createServer(config);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; all logs must go to stderr only.
  process.stderr.write(
    `local-ai-mcp ready (${config.providers.map((p) => `${p.name}=${p.host}`).join(", ")})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`local-ai-mcp fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
