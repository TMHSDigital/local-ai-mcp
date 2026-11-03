import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import {
  defaultSpeedCachePath,
  machineFingerprint,
  SPEED_MAX_AGE_MS,
  SpeedCache,
  type SpeedRecord,
  staleReason,
} from "../speed-cache.js";
import { type Candidate, rankCandidates, rankingReason } from "../tools/delegation.js";
import {
  FakeProvider,
  GB,
  HOSTED,
  LOCAL,
  OLLAMA_ENV,
  type OllamaHost,
  callTool,
  connectFromEnv,
  resources,
  serveOllama,
} from "./support.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-03T12:00:00Z");
const hw = resources({ gpus: [{ name: "RTX 4090", vramTotalBytes: 24 * GB, vramFreeBytes: 20 * GB, source: "t" }] });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "local-ai-mcp-speed-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const rec = (over: Partial<SpeedRecord> = {}): SpeedRecord => ({
  machine: "m1",
  host: LOCAL,
  provider: "ollama",
  model: "fast:3b",
  genTokensPerSec: 50,
  estimated: false,
  measuredAt: new Date(NOW).toISOString(),
  ...over,
});

describe("defaultSpeedCachePath", () => {
  it("uses the per-user cache dir for each OS, never the cwd", () => {
    expect(defaultSpeedCachePath({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u")).toBe(
      join("C:\\Users\\u\\AppData\\Local", "local-ai-mcp", "benchmarks.json"),
    );
    expect(defaultSpeedCachePath({}, "darwin", "/Users/u")).toBe(join("/Users/u", "Library", "Caches", "local-ai-mcp", "benchmarks.json"));
    expect(defaultSpeedCachePath({ XDG_CACHE_HOME: "/x" }, "linux", "/home/u")).toBe(join("/x", "local-ai-mcp", "benchmarks.json"));
    expect(defaultSpeedCachePath({}, "linux", "/home/u")).toBe(join("/home/u", ".cache", "local-ai-mcp", "benchmarks.json"));
  });

  it("is configured by LOCAL_AI_BENCHMARK_CACHE (blank = default, off = disabled)", () => {
    expect(loadConfig({}).benchmarkCachePath).toBe(defaultSpeedCachePath());
    expect(loadConfig({ LOCAL_AI_BENCHMARK_CACHE: "  " }).benchmarkCachePath).toBe(defaultSpeedCachePath());
    expect(loadConfig({ LOCAL_AI_BENCHMARK_CACHE: "off" }).benchmarkCachePath).toBeUndefined();
    expect(loadConfig({ LOCAL_AI_BENCHMARK_CACHE: "/tmp/b.json" }).benchmarkCachePath).toBe("/tmp/b.json");
  });
});

describe("machineFingerprint", () => {
  it("is stable per machine and changes with the hardware that sets speed", () => {
    const a = machineFingerprint(hw, "Box");
    expect(machineFingerprint(hw, "box")).toBe(a);
    expect(machineFingerprint(hw, "other")).not.toBe(a);
    const swapped = { ...hw, gpus: [{ name: "RTX 3060", vramTotalBytes: 12 * GB, source: "t" }] };
    expect(machineFingerprint(swapped, "Box")).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("staleReason", () => {
  it("expires records after 14 days", () => {
    expect(staleReason(rec(), {}, NOW + SPEED_MAX_AGE_MS)).toBeUndefined();
    expect(staleReason(rec(), {}, NOW + SPEED_MAX_AGE_MS + 1)).toMatch(/older than 14 days/);
    expect(staleReason(rec({ measuredAt: "garbage" }), {}, NOW)).toMatch(/older/);
  });

  it("invalidates when the model was re-pulled with a different quant or file", () => {
    const r = rec({ quantization: "Q4_K_M", sizeBytes: 2 * GB });
    expect(staleReason(r, { quantization: "Q4_K_M", sizeBytes: 2 * GB }, NOW)).toBeUndefined();
    expect(staleReason(r, { quantization: "Q8_0" }, NOW)).toMatch(/quantization changed/);
    expect(staleReason(r, { sizeBytes: 3 * GB }, NOW)).toMatch(/model file changed/);
    // Unknown on either side is not evidence of a change.
    expect(staleReason(rec(), { quantization: "Q8_0", sizeBytes: GB }, NOW)).toBeUndefined();
  });
});

describe("SpeedCache", () => {
  it("is a no-op when disabled", () => {
    const c = new SpeedCache(undefined);
    expect(c.enabled).toBe(false);
    expect(c.record(rec())).toBeUndefined();
    expect(c.all()).toEqual([]);
  });

  it("reads a missing or corrupt file as empty and drops malformed records", () => {
    const path = join(dir, "b.json");
    const c = new SpeedCache(path);
    expect(c.all()).toEqual([]);
    writeFileSync(path, "{not json");
    expect(c.all()).toEqual([]);
    writeFileSync(path, JSON.stringify({ records: [rec(), { model: "x" }, { ...rec(), genTokensPerSec: "fast" }] }));
    expect(c.all()).toHaveLength(1);
  });

  it("creates the directory, replaces the same machine/host/model, and keeps others", () => {
    const path = join(dir, "nested", "b.json");
    let now = NOW;
    const c = new SpeedCache(path, () => now);
    const { measuredAt: _, ...base } = rec();
    c.record(base);
    c.record({ ...base, model: "slow:7b", genTokensPerSec: 20 });
    now += DAY;
    c.record({ ...base, genTokensPerSec: 60 });
    const all = c.all();
    expect(all.map((r) => [r.model, r.genTokensPerSec])).toEqual([
      ["slow:7b", 20],
      ["fast:3b", 60],
    ]);
    expect(all[1].measuredAt).toBe(new Date(NOW + DAY).toISOString());
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
  });

  it("caps the file at 500 records, dropping the oldest", () => {
    const path = join(dir, "b.json");
    const old = Array.from({ length: 500 }, (_, i) =>
      rec({ model: `m${i}`, measuredAt: new Date(NOW - (500 - i) * 1000).toISOString() }),
    );
    writeFileSync(path, JSON.stringify({ records: old }));
    const { measuredAt: _, ...base } = rec({ model: "new" });
    new SpeedCache(path, () => NOW).record(base);
    const all = new SpeedCache(path).all();
    expect(all).toHaveLength(500);
    expect(all.some((r) => r.model === "m0")).toBe(false);
    expect(all.at(-1)?.model).toBe("new");
  });

  it("looks up only fresh records for this machine", () => {
    const path = join(dir, "b.json");
    writeFileSync(
      path,
      JSON.stringify({
        records: [
          rec(),
          rec({ machine: "m2", model: "other" }),
          rec({ model: "old", measuredAt: new Date(NOW - 15 * DAY).toISOString() }),
          rec({ model: "q", quantization: "Q4_K_M" }),
        ],
      }),
    );
    const find = new SpeedCache(path, () => NOW).lookup("m1");
    expect(find(LOCAL, "fast:3b")?.genTokensPerSec).toBe(50);
    expect(find("http://elsewhere:11434", "fast:3b")).toBeUndefined();
    expect(find(LOCAL, "other")).toBeUndefined();
    expect(find(LOCAL, "old")).toBeUndefined();
    expect(find(LOCAL, "q", { quantization: "Q8_0" })).toBeUndefined();
    expect(find(LOCAL, "q", { quantization: "Q4_K_M" })).toBeDefined();
  });
});

describe("rankCandidates with measured speed", () => {
  const p = new FakeProvider("ollama");
  const cand = (model: string, over: Partial<Candidate> = {}): Candidate => ({
    provider: p,
    model,
    tier: "installed",
    specialist: false,
    sizeBytes: GB,
    ...over,
  });

  it("puts measured models first (fastest first), then falls back to size", () => {
    const ranked = rankCandidates([
      cand("big", { sizeBytes: 40 * GB }),
      cand("slow", { speed: rec({ genTokensPerSec: 12 }) }),
      cand("fast", { speed: rec({ genTokensPerSec: 90 }) }),
      cand("mid", { sizeBytes: 8 * GB }),
    ]);
    expect(ranked.map((c) => c.model)).toEqual(["fast", "slow", "big", "mid"]);
  });

  it("never lets speed override specialty or readiness", () => {
    const ranked = rankCandidates([
      cand("fast-installed", { speed: rec({ genTokensPerSec: 200 }) }),
      cand("loaded", { tier: "loaded" }),
      cand("coder", { specialist: true }),
    ]);
    expect(ranked.map((c) => c.model)).toEqual(["coder", "loaded", "fast-installed"]);
  });

  it("explains the ranking", () => {
    const fast = cand("fast", { speed: rec({ genTokensPerSec: 90, estimated: true }) });
    expect(rankingReason(fast, [fast])).toBe("ranked by measured speed: 90 tok/s on this machine (benchmark 2026-11-03, estimated)");
    const big = cand("big");
    expect(rankingReason(big, [big])).toMatch(/ranked by size: no fresh benchmark/);
    expect(rankingReason(big, [big, fast])).toMatch(/ranked by size: outranks benchmarked models/);
  });
});

describe("benchmark -> delegate (HTTP layer)", () => {
  const hosts = (): Record<string, OllamaHost> => ({
    [LOCAL]: {
      live: true,
      tags: ["fast:3b", "slow:7b"],
      sizes: { "fast:3b": 2 * GB, "slow:7b": 5 * GB },
      ps: [{ name: "fast:3b", size_vram: 2 * GB, context_length: 8192 }],
      chat: { eval_count: 100, eval_duration: 1e9 },
    },
    "http://192.168.1.20:11434": { live: false, tags: [] },
    [HOSTED]: { live: true, tags: ["big:70b"], chat: { eval_count: 100, eval_duration: 1e8 } },
  });

  async function setup(now = () => NOW) {
    serveOllama(hosts());
    const speeds = new SpeedCache(join(dir, "b.json"), now);
    const { client } = await connectFromEnv(OLLAMA_ENV, hw, speeds);
    return { client, speeds };
  }

  it("ranks by size until a benchmark exists, then by measured speed", async () => {
    const { client, speeds } = await setup();
    const before = await callTool(client, "delegate", { task: "chat", prompt: "hi", stream: false });
    // fast:3b wins on readiness (loaded); nothing is benchmarked yet.
    expect(before.out.routing.model).toBe("fast:3b");
    expect(before.out.routing.why).toMatch(/ranked by size: no fresh benchmark/);

    await callTool(client, "benchmark", { model: "slow:7b", runs: 1, warmup: false });
    const [saved] = speeds.all();
    expect(saved).toMatchObject({
      host: LOCAL,
      provider: "ollama",
      model: "slow:7b",
      genTokensPerSec: 100,
      quantization: "Q4_K_M",
      sizeBytes: 5 * GB,
      estimated: false,
      machine: machineFingerprint(hw),
    });
    expect(saved).not.toHaveProperty("contextLength"); // slow:7b is not loaded

    await callTool(client, "benchmark", { model: "fast:3b", runs: 1, warmup: false });
    expect(speeds.all().find((r) => r.model === "fast:3b")?.contextLength).toBe(8192);
  });

  it("explains a measured-speed pick in routing.why without changing the output shape", async () => {
    const { client, speeds } = await setup();
    const before = await callTool(client, "delegate", { task: "chat", prompt: "hi", stream: false });
    speeds.record({
      machine: machineFingerprint(hw),
      host: LOCAL,
      provider: "ollama",
      model: "fast:3b",
      genTokensPerSec: 33.3,
      estimated: false,
    });
    const after = await callTool(client, "delegate", { task: "chat", prompt: "hi", stream: false });
    expect(after.out.routing.model).toBe("fast:3b");
    expect(after.out.routing.why).toContain("ranked by measured speed: 33.3 tok/s on this machine (benchmark 2026-11-03)");
    expect(Object.keys(after.out.routing).sort()).toEqual(Object.keys(before.out.routing).sort());
  });

  it("ignores stale results and falls back to size", async () => {
    let now = NOW;
    const { client, speeds } = await setup(() => now);
    serveOllama({ ...hosts(), [LOCAL]: { ...hosts()[LOCAL], ps: [] } });
    speeds.record({
      machine: machineFingerprint(hw),
      host: LOCAL,
      provider: "ollama",
      model: "fast:3b",
      genTokensPerSec: 500,
      estimated: false,
    });
    const fresh = await callTool(client, "delegate", { task: "chat", prompt: "hi", stream: false });
    expect(fresh.out.routing.model).toBe("fast:3b");
    now += 15 * DAY;
    const stale = await callTool(client, "delegate", { task: "chat", prompt: "hi", stream: false });
    expect(stale.out.routing.model).toBe("slow:7b");
    expect(stale.out.routing.why).toMatch(/ranked by size: no fresh benchmark/);
  });

  it("does not record hosted benchmarks", async () => {
    const { client, speeds } = await setup();
    const res = await callTool(client, "benchmark", { model: "big:70b", provider: "cloud", runs: 1, warmup: false });
    expect(res.out.results[0].genTokensPerSec.median).toBe(1000);
    expect(speeds.all()).toEqual([]);
  });

  it("keeps the benchmark result when the cache cannot be written", async () => {
    serveOllama(hosts());
    // A file where the cache directory should be makes the write fail.
    writeFileSync(join(dir, "blocker"), "");
    const speeds = new SpeedCache(join(dir, "blocker", "b.json"), () => NOW);
    const errs = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { client } = await connectFromEnv(OLLAMA_ENV, hw, speeds);
    const res = await callTool(client, "benchmark", { model: "fast:3b", runs: 1, warmup: false });
    expect(res.isError).toBe(false);
    expect(res.out.results[0]).toMatchObject({ model: "fast:3b", genTokensPerSec: { median: 100 } });
    expect(errs.mock.calls.some(([m]) => String(m).includes("could not save benchmark"))).toBe(true);
    errs.mockRestore();
  });
});
