import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), "utf8"));

describe("release metadata", () => {
  const pkg = read("package.json");
  const server = read("server.json");
  const manifest = read("mcpb/manifest.json");

  it("server.json and the .mcpb manifest track the package version (npm version syncs them)", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
  });

  it("registry name matches package.json mcpName and the npm identifier", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it("every env var the server reads is documented in .env.example", () => {
    const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    const source = readFileSync(new URL("../config.ts", import.meta.url), "utf8");
    const used = [...new Set([...source.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]))];
    for (const name of used) expect(example, name).toMatch(new RegExp(`^#?\\s*${name}=`, "m"));
  });

  it("server.json env vars and .mcpb user_config map to variables the server reads", () => {
    const source = readFileSync(new URL("../config.ts", import.meta.url), "utf8");
    for (const v of server.packages[0].environmentVariables) expect(source, v.name).toContain(`env.${v.name}`);
    for (const name of Object.keys(manifest.server.mcp_config.env)) expect(source, name).toContain(`env.${name}`);
  });
});
