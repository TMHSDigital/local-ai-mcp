import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompletionResult } from "../providers/types.js";
import { percentile, runMetrics } from "../tools/ops.js";
import { RESOURCE_URIS } from "../tools/resources.js";
import {
  GB,
  HOSTED,
  LAN,
  LOCAL,
  OLLAMA_ENV,
  type OllamaHost,
  callTool,
  connectFromEnv,
  resources,
  serveOllama,
} from "./support.js";

afterEach(() => vi.unstubAllGlobals());

const result = (over: Partial<CompletionResult>): CompletionResult => ({
  provider: "p",
  host: "h",
  local: true,
  model: "m",
  text: "",
  ...over,
});

describe("runMetrics", () => {
  it("prefers runtime-reported eval time", () => {
    const m = runMetrics(
      result({ completionTokens: 100, promptTokens: 50, timings: { evalMs: 2000, promptEvalMs: 100, ttftMs: 120.4, loadMs: 900.6 } }),
      2500,
    );
    expect(m).toEqual({
      totalMs: 2500,
      ttftMs: 120,
      loadMs: 901,
      promptTokens: 50,
      completionTokens: 100,
      promptTokensPerSec: 500,
      genTokensPerSec: 50,
      estimated: false,
    });
  });

  it("measures after the first token when only ttft is known", () => {
    const m = runMetrics(result({ completionTokens: 11, timings: { ttftMs: 500 } }), 1500);
    expect(m.genTokensPerSec).toBe(10);
    expect(m.estimated).toBe(false);
  });

  it("falls back to wall time and flags the estimate", () => {
    const m = runMetrics(result({ completionTokens: 20 }), 2000);
    expect(m).toMatchObject({ genTokensPerSec: 10, estimated: true });
    expect(m).not.toHaveProperty("ttftMs");
    expect(m).not.toHaveProperty("promptTokensPerSec");
  });

  it("reports no speed for an empty completion and honours usageEstimated", () => {
    const m = runMetrics(result({ usageEstimated: true, timings: { evalMs: 10 } }), 0);
    expect(m.genTokensPerSec).toBeUndefined();
    expect(m.completionTokens).toBe(0);
    expect(m.estimated).toBe(true);
  });

  it("percentile of nothing is undefined", () => {
    expect(percentile([], 50)).toBeUndefined();
    expect(percentile([3, 1, 2], 90)).toBe(3);
  });
});

const hosts = (over: Partial<Record<string, Partial<OllamaHost>>> = {}): Record<string, OllamaHost> => ({
  [LOCAL]: { live: true, tags: ["fast:3b", "slow:7b"], ...over[LOCAL] },
  [LAN]: { live: false, tags: [], ...over[LAN] },
  [HOSTED]: { live: true, tags: ["big:70b"], ...over[HOSTED] },
});

describe("health_check", () => {
  it("checks every configured provider, including dead and hosted ones", async () => {
    serveOllama(hosts());
    const { client } = await connectFromEnv(OLLAMA_ENV);
    const { out } = await callTool(client, "health_check");
    expect(out.health.ollama).toMatchObject({ live: true, version: "0.12.0" });
    expect(out.health.lan).toMatchObject({ live: false });
    expect(out.health.cloud).toMatchObject({ live: true, kind: "hosted" });
  });

  it("checks only the named provider", async () => {
    const calls = serveOllama(hosts());
    const { client } = await connectFromEnv(OLLAMA_ENV);
    const { out } = await callTool(client, "health_check", { provider: "cloud" });
    expect(Object.keys(out.health)).toEqual(["cloud"]);
    expect(calls.every((c) => c.url.startsWith(HOSTED))).toBe(true);
  });
});

describe("system_resources", () => {
  it("returns the hardware probe snapshot", async () => {
    serveOllama(hosts());
    const hw = resources({ gpus: [{ name: "RTX", vramTotalBytes: 24 * GB, vramFreeBytes: 20 * GB, source: "nvidia-smi" }] });
    const { client } = await connectFromEnv(OLLAMA_ENV, hw);
    const { out } = await callTool(client, "system_resources");
    expect(out).toMatchObject({ platform: "linux", cpuCount: 8, gpus: [{ name: "RTX", source: "nvidia-smi" }] });
  });
});

describe("fit_check", () => {
  it("errors with guidance when the size cannot be determined", async () => {
    serveOllama(hosts());
    const { client } = await connectFromEnv(OLLAMA_ENV);
    const { isError, out } = await callTool(client, "fit_check", { model: "no-such-model-anywhere" });
    expect(isError).toBe(true);
    expect(out.error).toMatch(/Could not determine size/);
  });

  it("warns when the context exceeds the model maximum", async () => {
    serveOllama(hosts());
    const { client } = await connectFromEnv(OLLAMA_ENV);
    const { isError, out } = await callTool(client, "fit_check", { model: "fast:3b", contextLength: 262144 });
    expect(isError).toBe(false);
    expect(out).toMatchObject({ provider: "ollama", maxContextLength: 131072 });
    expect(out.warning).toMatch(/exceeds the model's maximum \(131072\)/);
  });

  it("uses explicit sizes without a provider", async () => {
    serveOllama(hosts());
    const { client } = await connectFromEnv(OLLAMA_ENV);
    const { out } = await callTool(client, "fit_check", { model: "custom", sizeBytes: 4 * GB, parameterSize: "7B" });
    expect(out).not.toHaveProperty("provider");
    expect(out.fits).toBe(true);
    expect(out).not.toHaveProperty("warning");
  });
});

describe("benchmark", () => {
  it("requires model or models[]", async () => {
    serveOllama(hosts());
    const { client } = await connectFromEnv(OLLAMA_ENV);
    const { isError, out } = await callTool(client, "benchmark", {});
    expect(isError).toBe(true);
    expect(out.error).toMatch(/Provide model or models/);
  });

  it("ranks by generation speed and keeps per-model errors last", async () => {
    serveOllama(
      hosts({
        [LOCAL]: { chat: { eval_count: 100, eval_duration: 1e9, prompt_eval_count: 20, prompt_eval_duration: 1e8 } },
      }),
    );
    const { client } = await connectFromEnv(OLLAMA_ENV);
    const { out } = await callTool(client, "benchmark", { models: ["missing:1b", "fast:3b"], runs: 1, warmup: false });
    expect(out.results.map((r: any) => r.model)).toEqual(["fast:3b", "missing:1b"]);
    expect(out.results[0]).toMatchObject({
      provider: "ollama",
      runs: 1,
      genTokensPerSec: { median: 100 },
      promptTokensPerSec: { median: 200 },
    });
    expect(out.results[0]).not.toHaveProperty("warmupMs");
    expect(out.results[1].error).toBeDefined();
  });

  it("reports warmup time from the runtime's load duration", async () => {
    serveOllama(hosts({ [LOCAL]: { chat: { eval_count: 10, eval_duration: 1e8, load_duration: 7.5e8 } } }));
    const { client } = await connectFromEnv(OLLAMA_ENV);
    const { out } = await callTool(client, "benchmark", { model: "fast:3b", runs: 1 });
    expect(out.results[0]).toMatchObject({ warmupMs: 750 });
  });
});

describe("resources and prompts", () => {
  it("reads system, loaded (with per-provider errors), and per-provider models", async () => {
    serveOllama(hosts({ [LOCAL]: { ps: [{ name: "fast:3b", size_vram: GB }] } }));
    const { client } = await connectFromEnv(OLLAMA_ENV);
    const read = async (uri: string) =>
      JSON.parse(((await client.readResource({ uri })).contents[0] as { text: string }).text) as Record<string, any>;

    expect(await read(RESOURCE_URIS.system)).toMatchObject({ platform: "linux" });
    const loaded = await read(RESOURCE_URIS.loaded);
    expect(loaded.ollama).toEqual([expect.objectContaining({ id: "fast:3b", sizeVramBytes: GB })]);
    expect(loaded.cloud).toEqual([]);
    expect(loaded).not.toHaveProperty("lan"); // dead providers are skipped

    const { resources: listed } = await client.listResources();
    expect(listed.map((r) => r.uri)).toEqual(
      expect.arrayContaining(["local-ai://models/ollama", "local-ai://models/lan", "local-ai://models/cloud"]),
    );
    expect((await read("local-ai://models/ollama")).map((m: any) => m.id)).toEqual(["fast:3b", "slow:7b"]);

    const done = await client.complete({
      ref: { type: "ref/resource", uri: RESOURCE_URIS.models },
      argument: { name: "provider", value: "" },
    });
    expect(done.completion.values).toEqual(expect.arrayContaining(["ollama", "lan", "cloud"]));
  });

  it("captures a failing provider in the loaded resource", async () => {
    serveOllama(hosts());
    // Live for detection, broken for /api/ps.
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
      String(url).endsWith("/api/ps") && String(url).startsWith(HOSTED)
        ? new Response("down", { status: 503 })
        : real(url, init),
    );
    const { client } = await connectFromEnv(OLLAMA_ENV);
    const res = await client.readResource({ uri: RESOURCE_URIS.loaded });
    const loaded = JSON.parse((res.contents[0] as { text: string }).text);
    expect(loaded.cloud).toHaveProperty("error");
    expect(loaded.ollama).toEqual([]);
  });

  it("notifies local-ai://loaded subscribers until they unsubscribe", async () => {
    serveOllama(hosts());
    const { client } = await connectFromEnv(OLLAMA_ENV);
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
      updates.push(n.params.uri);
    });
    await client.subscribeResource({ uri: RESOURCE_URIS.loaded });
    await callTool(client, "load_model", { model: "fast:3b" });
    await vi.waitFor(() => expect(updates).toEqual([RESOURCE_URIS.loaded]));
    await client.unsubscribeResource({ uri: RESOURCE_URIS.loaded });
    await callTool(client, "unload_model", { model: "fast:3b", provider: "ollama" });
    await new Promise((r) => setTimeout(r, 20));
    expect(updates).toHaveLength(1);
  });

  it("renders every prompt with and without optional arguments", async () => {
    serveOllama(hosts());
    const { client } = await connectFromEnv(OLLAMA_ENV);
    const text = async (name: string, args?: Record<string, string>) => {
      const p = await client.getPrompt({ name, arguments: args });
      return (p.messages[0].content as { text: string }).text;
    };
    expect(await text("setup")).toContain('task "chat"');
    expect(await text("setup", { task: "code" })).toContain('task "code"');
    expect(await text("free-vram")).toContain("unload_model");
    expect(await text("benchmark-my-models")).toContain("installed models");
    expect(await text("benchmark-my-models", { task: "code" })).toContain("installed code models");
    expect(await text("pick-model", { task: "vision" })).toContain('"vision"');
  });
});
