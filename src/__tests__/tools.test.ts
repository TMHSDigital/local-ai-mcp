import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearHfCache } from "../catalog/huggingface.js";
import { loadConfig, type Config } from "../config.js";
import type { SystemResources } from "../hardware/index.js";
import { createServer } from "../server.js";
import { FakeProvider, GB, fakeHardware, mockFetch, resources, testConfig } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
  clearHfCache();
});

async function connect(
  providers: FakeProvider[],
  opts: { config?: Partial<Config>; hw?: SystemResources; elicit?: () => ElicitResult } = {},
) {
  const { server, ctx } = createServer(testConfig(opts.config), {
    providers,
    hardware: fakeHardware(opts.hw ?? resources({ gpus: [{ name: "gpu", vramFreeBytes: 20 * GB, source: "t" }] })),
  });
  const client = new Client({ name: "test", version: "0" }, { capabilities: opts.elicit ? { elicitation: {} } : {} });
  if (opts.elicit) {
    const fn = opts.elicit;
    client.setRequestHandler(ElicitRequestSchema, async () => fn());
  }
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, ctx };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) {
    const text = (res.content as Array<{ text: string }>)[0].text;
    throw new Error(JSON.parse(text).error);
  }
  return res.structuredContent as Record<string, any>;
}

const TOOL_NAMES = [
  "list_providers",
  "list_models",
  "list_loaded",
  "model_info",
  "pull_model",
  "remove_model",
  "load_model",
  "unload_model",
  "ensure_model",
  "health_check",
  "system_resources",
  "fit_check",
  "benchmark",
  "search_available",
  "suggest_model",
  "search_models",
  "complete",
  "embed",
  "delegate",
];

describe("tool surface", () => {
  it("registers every tool with annotations", async () => {
    const { client } = await connect([new FakeProvider("ollama")]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.remove_model.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    for (const n of ["list_providers", "list_models", "list_loaded", "model_info", "system_resources", "fit_check", "suggest_model"]) {
      expect(byName[n].annotations?.readOnlyHint, n).toBe(true);
    }
    expect(byName.pull_model.annotations?.openWorldHint).toBe(true);
    for (const t of tools) expect(t.outputSchema, t.name).toBeDefined();
  });

  it("mcp-tools.json matches the registered tools (run `npm run gen:tools`)", async () => {
    const { server } = createServer(loadConfig({}));
    const client = new Client({ name: "gen", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { tools } = await client.listTools();
    const manifest = JSON.parse(readFileSync(new URL("../../mcp-tools.json", import.meta.url), "utf8"));
    expect(manifest).toEqual(
      tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      })),
    );
  });

  it("list_providers reports kind and capabilities", async () => {
    const hosted = new FakeProvider("moonshot", { type: "moonshot", kind: "hosted" });
    const { client } = await connect([new FakeProvider("ollama"), hosted]);
    const out = await call(client, "list_providers");
    expect(out.providers.map((p: any) => [p.provider, p.kind, p.live])).toEqual([
      ["ollama", "local", true],
      ["moonshot", "hosted", true],
    ]);
  });
});

describe("complete / embed", () => {
  it("routes to the local provider that has the model and never to hosted", async () => {
    const ollama = new FakeProvider("ollama", { models: ["llama3.2:3b"] });
    const lms = new FakeProvider("lmstudio", { type: "lmstudio", models: ["qwen-7b"] });
    const hosted = new FakeProvider("moonshot", { type: "moonshot", kind: "hosted", models: ["kimi-k3"] });
    const { client } = await connect([ollama, lms, hosted]);
    const out = await call(client, "complete", { model: "qwen-7b", prompt: "hi", stream: false });
    expect(out).toMatchObject({ provider: "lmstudio", local: true, text: "ok" });
    expect(ollama.calls.some((c) => c.op === "complete")).toBe(false);
    await expect(call(client, "complete", { model: "kimi-k3", prompt: "hi" })).rejects.toThrow(/never used implicitly/);
    expect(hosted.calls.some((c) => c.op === "complete")).toBe(false);
    expect(await call(client, "complete", { model: "kimi-k3", prompt: "hi", provider: "moonshot" })).toMatchObject({
      provider: "moonshot",
      local: false,
    });
  });

  it("streams tokens as progress notifications", async () => {
    const { client } = await connect([new FakeProvider("ollama", { models: ["m"] })]);
    const progress: unknown[] = [];
    await client.callTool({ name: "complete", arguments: { model: "m", prompt: "x" } }, undefined, {
      onprogress: (p) => progress.push(p),
    });
    expect(progress).toEqual([{ progress: 1, message: "ok" }]);
  });

  it("validates JSON-schema output", async () => {
    const p = new FakeProvider("ollama", { models: ["m"] });
    p.reply = '{"a":1}';
    // FakeProvider returns raw text; parsed comes from the provider in real adapters.
    p.complete = async (params) => ({
      provider: "ollama",
      host: p.host,
      local: true,
      model: params.model,
      text: p.reply,
      parsed: { a: 1 },
    });
    const { client } = await connect([p]);
    const out = await call(client, "complete", {
      model: "m",
      prompt: "x",
      stream: false,
      responseFormat: { type: "json_schema", schema: { type: "object", required: ["b"] } },
    });
    expect(out.schemaValid).toBe(false);
    expect(out.schemaErrors[0]).toMatch(/must have required property 'b'/);
  });

  it("requires a prompt or messages", async () => {
    const { client } = await connect([new FakeProvider("ollama", { models: ["m"] })]);
    await expect(call(client, "complete", { model: "m" })).rejects.toThrow(/prompt/);
  });

  it("embed returns one vector per input", async () => {
    const { client } = await connect([new FakeProvider("ollama", { models: ["nomic-embed-text"] })]);
    const out = await call(client, "embed", { model: "nomic-embed-text", input: ["a", "b"] });
    expect(out.embeddings).toHaveLength(2);
  });
});

describe("lifecycle", () => {
  it("pull_model pulls on exactly one provider and reports progress with totals", async () => {
    const a = new FakeProvider("ollama");
    const b = new FakeProvider("lmstudio", { type: "lmstudio" });
    const { client } = await connect([a, b]);
    const progress: Array<{ progress: number; total?: number }> = [];
    const res = await client.callTool({ name: "pull_model", arguments: { model: "qwen3:8b" } }, undefined, {
      onprogress: (p) => progress.push(p),
    });
    expect(res.isError).toBeFalsy();
    expect([...a.calls, ...b.calls].filter((c) => c.op === "pull")).toHaveLength(1);
    expect(progress).toEqual([
      { progress: 50, total: 100, message: "downloading" },
      { progress: 100, total: 100, message: "success" },
    ]);
  });

  it("remove_model refuses without confirm when the client cannot elicit", async () => {
    const p = new FakeProvider("ollama", { models: ["m"] });
    const { client } = await connect([p]);
    expect((await call(client, "remove_model", { model: "m", provider: "ollama" })).remove).toMatchObject({ refused: true });
    expect(p.calls.some((c) => c.op === "remove")).toBe(false);
    expect((await call(client, "remove_model", { model: "m", provider: "ollama", confirm: true })).remove).toMatchObject({
      removed: true,
      confirmedVia: "argument",
    });
  });

  it("remove_model asks the user via elicitation, ignoring the model's confirm", async () => {
    const p = new FakeProvider("ollama", { models: ["m"] });
    const declined = await connect([p], { elicit: () => ({ action: "decline" }) });
    expect((await call(declined.client, "remove_model", { model: "m", provider: "ollama", confirm: true })).remove).toMatchObject({
      refused: true,
    });
    expect(p.calls.some((c) => c.op === "remove")).toBe(false);
    const accepted = await connect([p], { elicit: () => ({ action: "accept", content: { confirm: true } }) });
    expect((await call(accepted.client, "remove_model", { model: "m", provider: "ollama" })).remove).toMatchObject({
      removed: true,
      confirmedVia: "elicitation",
    });
  });

  it("ensure_model plans LRU eviction in dry-run and executes it", async () => {
    const p = new FakeProvider("ollama", {
      models: [{ id: "big:14b", sizeBytes: 9 * GB, parameterSize: "14B" }, "old:7b", "older:3b"],
      loaded: [
        { id: "old:7b", sizeVramBytes: 5 * GB, expiresAt: "2026-01-01T00:10:00Z" },
        { id: "older:3b", sizeVramBytes: 3 * GB, expiresAt: "2026-01-01T00:01:00Z" },
      ],
    });
    const hw = resources({ gpus: [{ name: "gpu", vramFreeBytes: 6 * GB, source: "t" }] });
    const { client } = await connect([p], { hw });
    const plan = await call(client, "ensure_model", { model: "big:14b", evict: "lru", dryRun: true });
    expect(plan.ready).toBe(false);
    expect(plan.plan[0]).toMatch(/^unload older:3b/);
    expect(plan.plan[1]).toMatch(/^unload old:7b/);
    expect(p.calls.some((c) => c.op === "unload")).toBe(false);

    const done = await call(client, "ensure_model", { model: "big:14b", evict: "lru", contextLength: 8192, keepAlive: "30m" });
    expect(done).toMatchObject({ ready: true, evicted: ["older:3b", "old:7b"] });
    expect(p.calls.find((c) => c.op === "load")).toMatchObject({ model: "big:14b", args: { keepAlive: "30m", contextLength: 8192 } });
  });

  it("ensure_model refuses to pull unless allowed", async () => {
    const { client } = await connect([new FakeProvider("ollama")]);
    await expect(call(client, "ensure_model", { model: "qwen3:8b" })).rejects.toThrow(/allowPull/);
    const out = await call(client, "ensure_model", { model: "qwen3:8b", allowPull: true });
    expect(out.ready).toBe(true);
    expect(out.plan[0]).toMatch(/^pull qwen3:8b/);
  });
});

describe("delegate", () => {
  it("prefers a loaded task specialist and explains the choice", async () => {
    const p = new FakeProvider("ollama", {
      models: [
        { id: "qwen2.5-coder:7b", sizeBytes: 4.7 * GB },
        { id: "llama3.1:8b", sizeBytes: 4.9 * GB },
        { id: "nomic-embed-text", sizeBytes: 0.3 * GB },
      ],
      loaded: ["qwen2.5-coder:7b"],
    });
    const { client } = await connect([p]);
    const out = await call(client, "delegate", { task: "code", prompt: "write fizzbuzz", stream: false });
    expect(out.routing).toMatchObject({ model: "qwen2.5-coder:7b", tier: "loaded" });
    expect(out.routing.why).toMatch(/already loaded/);
    expect(out.routing.considered.map((c: any) => c.model)).not.toContain("nomic-embed-text");
  });

  it("uses general models for summarize and never hosted ones", async () => {
    const hosted = new FakeProvider("moonshot", { type: "moonshot", kind: "hosted", models: ["kimi-k3"], loaded: ["kimi-k3"] });
    const local = new FakeProvider("ollama", { models: [{ id: "llama3.1:8b", sizeBytes: 4.9 * GB }] });
    const { client } = await connect([hosted, local]);
    const out = await call(client, "delegate", { task: "summarize", prompt: "text", stream: false });
    expect(out).toMatchObject({ provider: "ollama", local: true });
  });

  it("fails helpfully when nothing suitable is installed", async () => {
    const { client } = await connect([new FakeProvider("ollama", { models: ["nomic-embed-text"] })]);
    await expect(call(client, "delegate", { task: "vision", prompt: "x" })).rejects.toThrow(/allowPull/);
  });
});

describe("ops and catalog", () => {
  it("fit_check uses the provider's size and credits a loaded model", async () => {
    const p = new FakeProvider("ollama", {
      models: [{ id: "m", sizeBytes: 5 * GB, parameterSize: "8B" }],
      loaded: [{ id: "m", sizeBytes: 6 * GB, sizeVramBytes: 6 * GB }],
    });
    const hw = resources({ gpus: [{ name: "gpu", vramFreeBytes: 1 * GB, source: "t" }] });
    const { client } = await connect([p], { hw });
    const out = await call(client, "fit_check", { model: "m" });
    expect(out).toMatchObject({ sizeSource: "provider:ollama", loaded: true, target: "gpu", provider: "ollama" });
  });

  it("benchmark reports runtime-measured generation speed", async () => {
    const { client } = await connect([new FakeProvider("ollama", { models: ["m"] })]);
    const out = await call(client, "benchmark", { model: "m", runs: 2 });
    expect(out.results[0]).toMatchObject({ provider: "ollama", runs: 2, genTokensPerSec: { median: 100 }, estimated: false });
  });

  it("suggest_model puts the largest GPU-fitting model first, smallest with preferSpeed", async () => {
    const hw = resources({ gpus: [{ name: "gpu", vramFreeBytes: 12 * GB, source: "t" }] });
    const { client } = await connect([new FakeProvider("ollama", { models: ["qwen2.5-coder:7b"] })], { hw });
    const best = (await call(client, "suggest_model", { task: "code" })).suggestions;
    // 14B (~9 GB) is the largest code model that fits 12 GB free; 32B/34B do not.
    expect(best[0]).toMatchObject({ name: "qwen2.5-coder:14b", target: "gpu" });
    expect(best.find((s: any) => s.name === "qwen2.5-coder:7b")).toMatchObject({ installed: ["ollama"] });
    expect(best[0].reason).toMatch(/fits fully/);
    const sizesGpu = best.filter((s: any) => s.target === "gpu").map((s: any) => s.approxSizeBytes);
    expect([...sizesGpu].sort((a, b) => b - a)).toEqual(sizesGpu);
    const fast = (await call(client, "suggest_model", { task: "code", preferSpeed: true })).suggestions;
    expect(fast[0].approxSizeBytes).toBeLessThanOrEqual(fast[1].approxSizeBytes);
  });

  it("search_models (huggingface) returns per-quant fit and pull references", async () => {
    mockFetch((url) => {
      if (url.includes("/api/models?")) return { body: [{ id: "bartowski/Qwen-Coder-GGUF", downloads: 10 }] };
      return {
        body: {
          id: "bartowski/Qwen-Coder-GGUF",
          gguf: { total: 7.6e9, architecture: "qwen2", context_length: 32768 },
          siblings: [
            { rfilename: "Qwen-Coder-Q4_K_M.gguf", size: 4.7 * GB },
            { rfilename: "Qwen-Coder-Q8_0.gguf", size: 8.1 * GB },
            { rfilename: "Qwen-Coder-F16-00001-of-00002.gguf", size: 8 * GB },
            { rfilename: "Qwen-Coder-F16-00002-of-00002.gguf", size: 7.2 * GB },
            { rfilename: "mmproj-f16.gguf", size: 1 * GB },
            { rfilename: "README.md", size: 1 },
          ],
        },
      };
    });
    const hw = resources({ gpus: [{ name: "gpu", vramFreeBytes: 12 * GB, source: "t" }] });
    const { client } = await connect([], { hw });
    const out = await call(client, "search_models", { query: "qwen coder" });
    const r = out.results[0];
    expect(r.quants.map((q: any) => q.quant)).toEqual(["Q4_K_M", "Q8_0", "F16"]);
    expect(r.quants[2].files).toHaveLength(2);
    expect(r.best).toMatchObject({ quant: "Q8_0", target: "gpu", ollama: "hf.co/bartowski/Qwen-Coder-GGUF:Q8_0" });
  });

  it("search_models respects LOCAL_AI_DISABLE_NETWORK_SEARCH", async () => {
    const { client } = await connect([], { config: { allowNetworkSearch: false } });
    await expect(call(client, "search_models", { query: "x" })).rejects.toThrow(/disabled/);
    expect((await call(client, "search_models", { query: "coder", source: "catalog" })).results.length).toBeGreaterThan(0);
  });
});

describe("resources and prompts", () => {
  it("exposes system/loaded resources, per-provider models, and prompts", async () => {
    const { client } = await connect([new FakeProvider("ollama", { models: ["m"], loaded: ["m"] })]);
    const { resources: list } = await client.listResources();
    expect(list.map((r) => r.uri)).toEqual(
      expect.arrayContaining(["local-ai://system", "local-ai://loaded", "local-ai://models/ollama"]),
    );
    const loaded = await client.readResource({ uri: "local-ai://loaded" });
    expect(JSON.parse((loaded.contents[0] as { text: string }).text).ollama[0].id).toBe("m");
    const models = await client.readResource({ uri: "local-ai://models/ollama" });
    expect(JSON.parse((models.contents[0] as { text: string }).text)[0].id).toBe("m");
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["benchmark-my-models", "free-vram", "pick-model", "setup"]);
    const setup = await client.getPrompt({ name: "setup", arguments: { task: "code" } });
    expect((setup.messages[0].content as { text: string }).text).toMatch(/suggest_model for task "code"/);
  });

  it("notifies subscribers of local-ai://loaded after load/unload", async () => {
    const { client } = await connect([new FakeProvider("ollama", { models: ["m"] })]);
    const updates: string[] = [];
    const { ResourceUpdatedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => void updates.push(n.params.uri));
    await client.subscribeResource({ uri: "local-ai://loaded" });
    await call(client, "load_model", { model: "m" });
    await new Promise((r) => setTimeout(r, 10));
    expect(updates).toEqual(["local-ai://loaded"]);
  });
});
