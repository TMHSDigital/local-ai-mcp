import { describe, expect, it } from "vitest";
import { computeFit, estimateKvCacheBytes, parseParameterBillions } from "../fit.js";
import { GB, resources } from "./support.js";

const KiB = 1024;
const MiB = 1024 * 1024;

const LLAMA31_8B = { layers: 32, kvHeads: 8, keyLength: 128, valueLength: 128 };
const QWEN25_7B = { layers: 28, kvHeads: 4, keyLength: 128, valueLength: 128 };
const LLAMA31_70B = { layers: 80, kvHeads: 8, keyLength: 128, valueLength: 128 };

describe("parseParameterBillions", () => {
  it.each([
    ["7B", 7],
    ["3.8B", 3.8],
    ["137M", 0.137],
    ["huge", undefined],
    [undefined, undefined],
  ])("%s", (s, v) => expect(parseParameterBillions(s)).toBe(v));
});

describe("estimateKvCacheBytes", () => {
  it("is exact from architecture: Llama 3.1 8B = 128 KiB/token fp16", () => {
    const r = estimateKvCacheBytes(0, { architecture: LLAMA31_8B, contextLength: 1024 });
    expect(r.method).toBe("architecture");
    expect(r.kvCacheBytes).toBe(128 * MiB);
    expect(estimateKvCacheBytes(0, { architecture: LLAMA31_8B, contextLength: 32768 }).kvCacheBytes).toBe(4 * 1024 * MiB);
  });

  it("matches known models within 10%", () => {
    // Qwen2.5 7B: 2*28*4*128*2 = 56 KiB/token; Llama 3.1 70B: 320 KiB/token
    expect(estimateKvCacheBytes(0, { architecture: QWEN25_7B, contextLength: 1 }).kvCacheBytes).toBe(56 * KiB);
    expect(estimateKvCacheBytes(0, { architecture: LLAMA31_70B, contextLength: 1 }).kvCacheBytes).toBe(320 * KiB);
  });

  it("scales with KV quantization", () => {
    const f16 = estimateKvCacheBytes(0, { architecture: LLAMA31_8B }).kvCacheBytes;
    const q8 = estimateKvCacheBytes(0, { architecture: LLAMA31_8B, kvCacheType: "q8_0" }).kvCacheBytes;
    const q4 = estimateKvCacheBytes(0, { architecture: LLAMA31_8B, kvCacheType: "q4_0" }).kvCacheBytes;
    expect(q8 / f16).toBeCloseTo(34 / 64, 3);
    expect(q4 / f16).toBeCloseTo(18 / 64, 3);
  });

  it("parameter heuristic lands near real GQA models (not 16x low)", () => {
    const perToken = (b: string) => estimateKvCacheBytes(0, { parameterSize: b, contextLength: 1 }).kvCacheBytes / KiB;
    // Real: 8B ~128 KiB, 70B ~320 KiB, 1B ~32 KiB. Heuristic should be within ~0.6x-2x.
    expect(perToken("8B")).toBeGreaterThan(128 * 0.8);
    expect(perToken("8B")).toBeLessThan(128 * 1.5);
    expect(perToken("70B")).toBeGreaterThan(320);
    expect(perToken("70B")).toBeLessThan(320 * 2);
    expect(perToken("1B")).toBeGreaterThan(32 * 0.8);
  });

  it("weight-ratio fallback scales with context", () => {
    const a = estimateKvCacheBytes(10 * GB, { contextLength: 4096 });
    const b = estimateKvCacheBytes(10 * GB, { contextLength: 8192 });
    expect(a.method).toBe("weight-ratio");
    expect(b.kvCacheBytes).toBe(a.kvCacheBytes * 2);
  });
});

describe("computeFit", () => {
  it("fits on GPU with headroom", () => {
    const out = computeFit(resources({ gpus: [{ name: "4090", vramFreeBytes: 22 * GB, source: "t" }] }), 5 * GB, {
      architecture: LLAMA31_8B,
    });
    expect(out).toMatchObject({ fits: true, target: "gpu", kvEstimate: "architecture", gpuCount: 1 });
    expect(out.requiredBytes).toBe(out.weightBytes + out.kvCacheBytes);
  });

  it("long context that the old heuristic called a GPU fit no longer does", () => {
    // 8B Q4 (~4.7 GB) at 128K context: KV alone is 16 GiB.
    const out = computeFit(resources({ gpus: [{ name: "4090", vramFreeBytes: 22 * GB, source: "t" }] }), 4.7 * GB, {
      architecture: LLAMA31_8B,
      contextLength: 131072,
    });
    expect(out.target).not.toBe("gpu");
  });

  it("sums VRAM across GPUs", () => {
    const two = resources({
      gpus: [
        { name: "a", vramFreeBytes: 12 * GB, source: "t" },
        { name: "b", vramFreeBytes: 12 * GB, source: "t" },
      ],
    });
    const out = computeFit(two, 15 * GB, { parameterSize: "24B" });
    expect(out).toMatchObject({ target: "gpu", gpuCount: 2 });
    expect(out.note).toMatch(/split across 2 GPUs/);
  });

  it("reports partial offload with a GPU fraction", () => {
    const out = computeFit(resources({ gpus: [{ name: "a", vramFreeBytes: 8 * GB, source: "t" }] }), 12 * GB, {
      parameterSize: "20B",
    });
    expect(out.target).toBe("partial");
    expect(out.gpuFraction).toBeGreaterThan(0.4);
    expect(out.gpuFraction).toBeLessThan(0.6);
  });

  it("treats Apple unified memory as one pool", () => {
    const mac = resources({
      platform: "darwin",
      ramFreeBytes: 20 * GB,
      gpus: [{ name: "Apple M3", vramTotalBytes: 21 * GB, vramFreeBytes: 16 * GB, unified: true, source: "sysctl" }],
    });
    expect(computeFit(mac, 8 * GB, { parameterSize: "14B" })).toMatchObject({ target: "gpu", unifiedMemory: true });
    // Bigger than the GPU working set but within RAM: partial, judged against RAM only (not GPU+RAM).
    const big = computeFit(mac, 15 * GB, { parameterSize: "27B" });
    expect(big.target).toBe("partial");
    expect(big.availableBytes).toBe(20 * GB);
    expect(computeFit(mac, 30 * GB, { parameterSize: "70B" }).target).toBe("none");
  });

  it("credits back memory an already-loaded model uses", () => {
    const r = resources({ gpus: [{ name: "a", vramFreeBytes: 1 * GB, source: "t" }] });
    expect(computeFit(r, 5 * GB, { parameterSize: "8B" }).target).not.toBe("gpu");
    expect(computeFit(r, 5 * GB, { parameterSize: "8B", residentVramBytes: 6 * GB }).target).toBe("gpu");
  });

  it("falls back to CPU, then none", () => {
    expect(computeFit(resources(), 5 * GB, { parameterSize: "8B" })).toMatchObject({ target: "cpu" });
    const out = computeFit(resources({ ramFreeBytes: 2 * GB }), 50 * GB, { parameterSize: "70B" });
    expect(out).toMatchObject({ fits: false, target: "none" });
    expect(out.note).toMatch(/smaller quant/);
  });
});
