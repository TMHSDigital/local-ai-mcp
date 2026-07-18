import { describe, expect, it } from "vitest";
import type { HardwareProbe, SystemResources } from "../hardware/index.js";
import { computeFit, estimateKvCacheBytes, parseParameterBillions } from "../tools/helpers.js";

const GB = 1024 * 1024 * 1024;

function probe(resources: SystemResources): HardwareProbe {
  return { async getSystemResources() { return resources; } };
}

describe("parseParameterBillions", () => {
  it("parses B and M suffixes", () => {
    expect(parseParameterBillions("7B")).toBe(7);
    expect(parseParameterBillions("3.8B")).toBe(3.8);
    expect(parseParameterBillions("137M")).toBeCloseTo(0.137);
    expect(parseParameterBillions("bogus")).toBeUndefined();
  });
});

describe("estimateKvCacheBytes", () => {
  it("scales with context and parameter size", () => {
    const a = estimateKvCacheBytes(5 * GB, { parameterSize: "7B", contextLength: 4096 });
    const b = estimateKvCacheBytes(5 * GB, { parameterSize: "7B", contextLength: 8192 });
    expect(a.kvCacheBytes).toBe(7 * 4 * 1024 * 1024); // 7B * 4K/1K * 1MiB
    expect(b.kvCacheBytes).toBe(a.kvCacheBytes * 2);
  });

  it("falls back to 15% of weight when parameter size unknown", () => {
    const out = estimateKvCacheBytes(10 * GB, { contextLength: 2048 });
    expect(out.kvCacheBytes).toBe(Math.round(10 * GB * 0.15));
  });
});

describe("computeFit", () => {
  it("fits on GPU when VRAM is ample", () => {
    const resources: SystemResources = {
      platform: "linux",
      ramTotalBytes: 32 * GB,
      ramFreeBytes: 16 * GB,
      cpuCount: 8,
      gpus: [{ name: "RTX 4090", vramTotalBytes: 24 * GB, vramFreeBytes: 20 * GB }],
    };
    const out = computeFit(resources, 5 * GB, { parameterSize: "7B", contextLength: 4096 });
    expect(out.fits).toBe(true);
    expect(out.target).toBe("gpu");
    expect(out.weightBytes).toBe(5 * GB);
    expect(out.kvCacheBytes).toBeGreaterThan(0);
    expect(out.requiredBytes).toBe(out.weightBytes + out.kvCacheBytes);
    expect(out.contextLength).toBe(4096);
  });

  it("falls back to CPU/RAM when no GPU present", () => {
    const resources: SystemResources = {
      platform: "linux",
      ramTotalBytes: 32 * GB,
      ramFreeBytes: 24 * GB,
      cpuCount: 8,
      gpus: [],
    };
    const out = computeFit(resources, 5 * GB);
    expect(out.fits).toBe(true);
    expect(out.target).toBe("cpu");
  });

  it("falls back to CPU when GPU VRAM is too small but RAM is large", () => {
    const resources: SystemResources = {
      platform: "win32",
      ramTotalBytes: 64 * GB,
      ramFreeBytes: 40 * GB,
      cpuCount: 16,
      gpus: [{ name: "GTX 1650", vramTotalBytes: 4 * GB, vramFreeBytes: 3 * GB }],
    };
    const out = computeFit(resources, 8 * GB);
    expect(out.fits).toBe(true);
    expect(out.target).toBe("cpu");
  });

  it("returns fits:false/target:none when neither has room", () => {
    const resources: SystemResources = {
      platform: "linux",
      ramTotalBytes: 8 * GB,
      ramFreeBytes: 2 * GB,
      cpuCount: 4,
      gpus: [{ name: "GTX 1650", vramTotalBytes: 4 * GB, vramFreeBytes: 1 * GB }],
    };
    const out = computeFit(resources, 8 * GB);
    expect(out.fits).toBe(false);
    expect(out.target).toBe("none");
  });

  it("larger context can push a borderline model off GPU", () => {
    const resources: SystemResources = {
      platform: "linux",
      ramTotalBytes: 64 * GB,
      ramFreeBytes: 48 * GB,
      cpuCount: 8,
      // ~6.2 GB free: 5GB + small KV fits with headroom; 70B@32k KV (~2.2GB) does not
      gpus: [{ name: "mid", vramTotalBytes: 8 * GB, vramFreeBytes: Math.round(6.2 * GB) }],
    };
    const low = computeFit(resources, 5 * GB, { parameterSize: "7B", contextLength: 2048 });
    const high = computeFit(resources, 5 * GB, { parameterSize: "70B", contextLength: 32768 });
    expect(low.target).toBe("gpu");
    expect(high.target).not.toBe("gpu");
  });

  it("stubbed HardwareProbe is honored end-to-end", async () => {
    const hw = probe({
      platform: "linux",
      ramTotalBytes: 16 * GB,
      ramFreeBytes: 10 * GB,
      cpuCount: 8,
      gpus: [{ name: "RTX 3060", vramTotalBytes: 12 * GB, vramFreeBytes: 10 * GB }],
    });
    const res = await hw.getSystemResources();
    const out = computeFit(res, 4 * GB);
    expect(out.target).toBe("gpu");
  });
});
