// Keeps server.json (MCP Registry) and mcpb/manifest.json (Claude Desktop
// extension) at the package.json version. Runs from the npm `version`
// lifecycle hook, so `npm version <bump>` updates all three together.
import { readFileSync, writeFileSync } from "node:fs";

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
const write = (p, data) => writeFileSync(new URL(`../${p}`, import.meta.url), `${JSON.stringify(data, null, 2)}\n`);

const { version } = read("package.json");
const server = read("server.json");
server.version = version;
for (const pkg of server.packages ?? []) pkg.version = version;
write("server.json", server);

const manifest = read("mcpb/manifest.json");
manifest.version = version;
write("mcpb/manifest.json", manifest);

console.log(`server.json and mcpb/manifest.json -> ${version}`);
