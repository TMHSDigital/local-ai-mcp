// Regenerates mcp-tools.json from the registered tools (default config).
// Also writes the `tools` array of mcpb/manifest.json from the same list.
// Run after `npm run build`: `npm run gen:tools`. CI fails if either file drifts.
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../dist/config.js";
import { createServer } from "../dist/server.js";

const { server } = createServer(loadConfig({}));
const client = new Client({ name: "gen-tools", version: "0" });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st), client.connect(ct)]);
const { tools } = await client.listTools();
const manifest = tools.map((t) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: t.annotations,
}));
writeFileSync(new URL("../mcp-tools.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);

// The Claude Desktop bundle lists the same tools (name + description).
const mcpbUrl = new URL("../mcpb/manifest.json", import.meta.url);
const mcpb = JSON.parse(readFileSync(mcpbUrl, "utf8"));
mcpb.tools = manifest.map(({ name, description }) => ({ name, description }));
writeFileSync(mcpbUrl, `${JSON.stringify(mcpb, null, 2)}\n`);

await client.close();
console.log(`mcp-tools.json and mcpb/manifest.json: ${manifest.length} tools`);
