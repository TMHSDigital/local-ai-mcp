import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerModelRunnerProvider, parseHumanSize } from "../providers/dockermodelrunner.js";
import { FoundryLocalProvider } from "../providers/foundrylocal.js";
import { MlxProvider } from "../providers/mlx.js";
import { parseVllmMetrics, VllmProvider } from "../providers/vllm.js";
import { mockFetch } from "./support.js";

const OPTS = { timeoutMs: 5000 };

afterEach(() => vi.unstubAllGlobals());

describe("VllmProvider", () => {
  it("parses Prometheus metrics, summing label sets", () => {
    const text = [
      "# HELP vllm:kv_cache_usage_perc x",
      'vllm:kv_cache_usage_perc{engine="0",model_name="m"} 0.25',
      'vllm:num_requests_running{engine="0"} 2',
      'vllm:num_requests_waiting{engine="0"} 1',
      'vllm:num_requests_waiting{engine="1"} 3',
      "vllm:other 9",
    ].join("\n");
    expect(parseVllmMetrics(text)).toEqual({ kvCacheUsage: 0.25, requestsRunning: 2, requestsWaiting: 4 });
  });

  it("health reports version and metrics", async () => {
    mockFetch((url) => {
      if (url.endsWith("/health")) return { text: "" };
      if (url.endsWith("/version")) return { body: { version: "0.11.0" } };
      return { text: "vllm:kv_cache_usage_perc 0.5\n" };
    });
    const h = await new VllmProvider("http://localhost:8000/v1").health(OPTS);
    expect(h).toMatchObject({ live: true, version: "0.11.0", metrics: { kvCacheUsage: 0.5 } });
  });

  it("uses /v1 for OpenAI routes", async () => {
    const calls = mockFetch(() => ({ body: { data: [{ id: "Qwen/Qwen3-8B", max_model_len: 40960 }] } }));
    const models = await new VllmProvider("http://localhost:8000").listModels(OPTS);
    expect(calls[0].url).toBe("http://localhost:8000/v1/models");
    expect(models[0].contextLength).toBe(40960);
  });
});

describe("MlxProvider", () => {
  it("is complete-only with JIT loading", async () => {
    const p = new MlxProvider("http://localhost:8081");
    expect(p.capabilities()).toMatchObject({ complete: true, embed: false, load: false });
    expect((await p.load("mlx-community/x")).detail).toMatch(/first use/);
    await expect(p.embed({ model: "x", input: "y" }, OPTS)).rejects.toThrow(/no embeddings endpoint/);
  });

  it("detects via /health", async () => {
    const calls = mockFetch(() => ({ body: { status: "ok" } }));
    expect(await new MlxProvider("http://localhost:8081").detect(OPTS)).toBe(true);
    expect(calls[0].url).toBe("http://localhost:8081/health");
  });
});

describe("DockerModelRunnerProvider", () => {
  it("parses human sizes", () => {
    expect(parseHumanSize("4.68 GiB")).toBe(Math.round(4.68 * 1024 ** 3));
    expect(parseHumanSize("512 MB")).toBe(512e6);
    expect(parseHumanSize("x")).toBeUndefined();
  });

  it("maps native /models entries (one per tag)", async () => {
    mockFetch(() => ({
      body: [
        {
          id: "sha256:abc",
          tags: ["ai/smollm2:latest", "ai/smollm2"],
          config: { format: "gguf", quantization: "Q4_K_M", parameters: "361.82 M", architecture: "llama", size: "256.35 MiB" },
        },
      ],
    }));
    const models = await new DockerModelRunnerProvider("http://localhost:12434").listModels(OPTS);
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "ai/smollm2:latest",
      family: "llama",
      quantization: "Q4_K_M",
      parameterSize: "361.82M",
      sizeBytes: Math.round(256.35 * 1024 ** 2),
    });
  });

  it("pulls via /models/create and deletes via /models/{ns}/{name}", async () => {
    const calls = mockFetch((url) =>
      url.endsWith("/models/create") ? { chunks: ['{"type":"progress","message":"Downloaded 10 MB","total":100,"pulled":10}\n'] } : { text: "" },
    );
    const p = new DockerModelRunnerProvider("http://localhost:12434");
    const progress: unknown[] = [];
    await p.pull("ai/smollm2", { ...OPTS, onProgress: (x) => void progress.push(x) });
    await p.remove("ai/smollm2", OPTS);
    expect(calls[0]).toMatchObject({ method: "POST", body: { from: "ai/smollm2" } });
    expect(progress).toEqual([{ status: "Downloaded 10 MB", completed: 10, total: 100 }]);
    expect(calls[1]).toMatchObject({ method: "DELETE", url: "http://localhost:12434/models/ai/smollm2" });
  });

  it("routes inference through /engines/v1", async () => {
    const calls = mockFetch(() => ({ body: { choices: [{ message: { content: "x" } }] } }));
    await new DockerModelRunnerProvider("http://localhost:12434").complete({ model: "ai/smollm2", prompt: "x" }, OPTS);
    expect(calls[0].url).toBe("http://localhost:12434/engines/v1/chat/completions");
  });
});

describe("FoundryLocalProvider", () => {
  it("lists cached and loaded models and loads/unloads via GET", async () => {
    const calls = mockFetch((url) => {
      if (url.endsWith("/openai/models")) return { body: ["phi-4-mini", "qwen2.5-7b"] };
      if (url.endsWith("/openai/loadedmodels")) return { body: ["phi-4-mini"] };
      return { text: "" };
    });
    const p = new FoundryLocalProvider("http://localhost:5272");
    expect((await p.listModels(OPTS)).map((m) => m.id)).toEqual(["phi-4-mini", "qwen2.5-7b"]);
    expect((await p.listLoaded(OPTS)).map((m) => m.id)).toEqual(["phi-4-mini"]);
    await p.load("qwen2.5-7b", { ...OPTS, keepAlive: "10m" });
    await p.unload("qwen2.5-7b", OPTS);
    expect(calls.slice(2).map((c) => [c.method, c.url])).toEqual([
      ["GET", "http://localhost:5272/openai/load/qwen2.5-7b?ttl=600"],
      ["GET", "http://localhost:5272/openai/unload/qwen2.5-7b?force=true"],
    ]);
  });

  it("downloads catalog models with progress and surfaces failures", async () => {
    const calls = mockFetch((url) =>
      url.endsWith("/foundry/list")
        ? { body: { models: [{ name: "phi-4-mini-cuda", alias: "phi-4-mini", uri: "azureml://x", providerType: "AzureFoundry" }] } }
        : { chunks: ['("model.onnx", 42.5)\n', '{"Success":true}\n'] },
    );
    const progress: unknown[] = [];
    await new FoundryLocalProvider("http://localhost:5272").pull("phi-4-mini", { ...OPTS, onProgress: (x) => void progress.push(x) });
    expect(calls[1].body).toMatchObject({ model: { Uri: "azureml://x", Name: "phi-4-mini-cuda", ProviderType: "AzureFoundry" } });
    expect(progress).toEqual([{ status: "model.onnx", completed: 42.5, total: 100 }]);

    mockFetch((url) =>
      url.endsWith("/foundry/list")
        ? { body: { models: [{ name: "m", uri: "u" }] } }
        : { chunks: ['{"Success":false,"ErrorMessage":"disk full"}\n'] },
    );
    await expect(new FoundryLocalProvider("http://localhost:5272").pull("m", OPTS)).rejects.toThrow(/disk full/);
  });
});
