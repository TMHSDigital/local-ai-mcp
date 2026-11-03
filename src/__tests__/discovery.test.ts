import { afterEach, describe, expect, it, vi } from "vitest";
import { type OllamaHost, OLLAMA_ENV as env, HOSTED, LAN, LOCAL, callTool as call, connectFromEnv, serveOllama as serve } from "./support.js";

type HostState = OllamaHost;

const connect = async (config: Record<string, string> = {}) => (await connectFromEnv({ ...env, ...config })).client;

afterEach(() => vi.unstubAllGlobals());

describe("list_models", () => {
  it("lists models per live provider and skips dead ones", async () => {
    serve({
      [LOCAL]: { live: true, tags: ["llama3.2:3b"] },
      [LAN]: { live: false, tags: [] },
      [HOSTED]: { live: true, tags: ["big:70b"] },
    });
    const { isError, out } = await call(await connect(), "list_models");
    expect(isError).toBe(false);
    expect(Object.keys(out.models).sort()).toEqual(["cloud", "ollama"]);
    expect(out.models.ollama).toEqual([
      expect.objectContaining({ id: "llama3.2:3b", provider: "ollama", quantization: "Q4_K_M" }),
    ]);
  });

  it("queries only the named provider", async () => {
    const calls = serve({
      [LOCAL]: { live: true, tags: ["a"] },
      [LAN]: { live: true, tags: ["b"] },
      [HOSTED]: { live: true, tags: [] },
    });
    const { out } = await call(await connect(), "list_models", { provider: "lan" });
    expect(Object.keys(out.models)).toEqual(["lan"]);
    expect(calls.some((c) => c.url.startsWith(LOCAL) && c.url.endsWith("/api/tags"))).toBe(false);
  });

  it("reports a per-provider error without failing the call", async () => {
    serve({
      [LOCAL]: { live: true, tags: [], tagsStatus: 500 },
      [LAN]: { live: true, tags: ["b"] },
      [HOSTED]: { live: false, tags: [] },
    });
    const { isError, out } = await call(await connect(), "list_models");
    expect(isError).toBe(false);
    expect(out.models.ollama).toHaveProperty("error");
    expect(out.models.lan).toEqual([expect.objectContaining({ id: "b" })]);
  });
});

describe("list_loaded", () => {
  it("maps VRAM and context length from /api/ps", async () => {
    serve({
      [LOCAL]: { live: true, tags: ["m"], ps: [{ name: "m", size_vram: 3 * 1024 ** 3, context_length: 8192 }] },
      [LAN]: { live: true, tags: [] },
      [HOSTED]: { live: false, tags: [] },
    });
    const { out } = await call(await connect(), "list_loaded");
    expect(out.loaded.ollama).toEqual([
      expect.objectContaining({ id: "m", sizeVramBytes: 3 * 1024 ** 3, contextLength: 8192 }),
    ]);
    expect(out.loaded.lan).toEqual([]);
  });
});

describe("model_info", () => {
  const hosts = (): Record<string, HostState> => ({
    [LOCAL]: { live: true, tags: ["llama3.2:3b"] },
    [LAN]: { live: true, tags: ["qwen:7b"] },
    [HOSTED]: { live: true, tags: ["big:70b"] },
  });

  it("queries only the local providers that have the model", async () => {
    const calls = serve(hosts());
    const { isError, out } = await call(await connect(), "model_info", { model: "qwen:7b" });
    expect(isError).toBe(false);
    expect(out.model).toBe("qwen:7b");
    expect(Object.keys(out.info)).toEqual(["lan"]);
    expect(out.info.lan).toMatchObject({ family: "llama", contextLength: 131072 });
    expect(calls.filter((c) => c.url.endsWith("/api/show")).map((c) => c.url)).toEqual([`${LAN}/api/show`]);
  });

  it("fails with guidance when no live local provider has the model", async () => {
    const calls = serve(hosts());
    const { isError, out } = await call(await connect(), "model_info", { model: "big:70b" });
    expect(isError).toBe(true);
    expect(out.error).toMatch(/not found on any live local provider/);
    // The hosted instance has it, but implicit calls never reach it.
    expect(calls.some((c) => c.url.startsWith(HOSTED) && c.url.endsWith("/api/show"))).toBe(false);
  });

  it("includes hosted providers when hosted fallback is allowed", async () => {
    serve(hosts());
    const { isError, out } = await call(await connect({ LOCAL_AI_ALLOW_HOSTED_FALLBACK: "1" }), "model_info", {
      model: "big:70b",
    });
    expect(isError).toBe(false);
    expect(Object.keys(out.info)).toEqual(["cloud"]);
  });

  it("goes straight to a named provider and reports its error per provider", async () => {
    serve(hosts());
    const client = await connect();
    const named = await call(client, "model_info", { model: "big:70b", provider: "cloud" });
    expect(named.out.info.cloud).toMatchObject({ id: "big:70b", parameterSize: "3.2B" });
    const missing = await call(client, "model_info", { model: "nope", provider: "ollama" });
    expect(missing.isError).toBe(false);
    expect(missing.out.info.ollama).toHaveProperty("error");
  });
});
