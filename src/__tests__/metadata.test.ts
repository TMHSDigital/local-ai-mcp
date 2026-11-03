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

  describe("env-var parity", () => {
    const source = readFileSync(new URL("../config.ts", import.meta.url), "utf8");
    const used = [...new Set([...source.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]))];
    // Timeouts and cache TTLs are tuning knobs: documented in .env.example but
    // not surfaced as install-time settings.
    const isTuning = (name: string) => /^LOCAL_AI_.+_MS$/.test(name);
    const userFacing = used.filter((n) => !isTuning(n)).sort();
    const registryVars = server.packages[0].environmentVariables as { name: string; isSecret?: boolean }[];
    const mcpbEnv = manifest.server.mcp_config.env as Record<string, string>;

    it("server.json lists every user-facing env var", () => {
      expect(registryVars.map((v) => v.name).sort()).toEqual(userFacing);
    });

    it(".mcpb manifest maps every user-facing env var to a user_config field", () => {
      expect(Object.keys(mcpbEnv).sort()).toEqual(userFacing);
      for (const [name, value] of Object.entries(mcpbEnv)) {
        const key = value.match(/^\$\{user_config\.([a-z0-9_]+)\}$/)?.[1];
        expect(key, name).toBeDefined();
        expect(manifest.user_config[key as string], name).toBeDefined();
      }
    });

    it("API keys are secret in server.json and sensitive in the .mcpb manifest", () => {
      for (const v of registryVars) expect(Boolean(v.isSecret), v.name).toBe(v.name.endsWith("_API_KEY"));
      for (const [name, value] of Object.entries(mcpbEnv)) {
        const key = value.slice("${user_config.".length, -1);
        expect(Boolean(manifest.user_config[key].sensitive), name).toBe(name.endsWith("_API_KEY"));
      }
    });
  });

  it(".mcpb tools list matches mcp-tools.json (npm run gen:tools)", () => {
    const tools = read("mcp-tools.json") as { name: string; description: string }[];
    expect(manifest.tools).toEqual(tools.map(({ name, description }) => ({ name, description })));
  });
});
