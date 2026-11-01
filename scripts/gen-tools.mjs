// Regenerates mcp-tools.json from the registered tools (default config).
// Run after `npm run build`: `npm run gen:tools`. CI fails if the file drifts.
import { writeFileSync } from "node:fs";
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
await client.close();
console.log(`mcp-tools.json: ${manifest.length} tools`);
