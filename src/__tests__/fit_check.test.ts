import { describe, expect, it } from "vitest";
import type { HardwareProbe, SystemResources } from "../hardware/index.js";
import { computeFit } from "../tools/helpers.js";

const GB = 1024 * 1024 * 1024;

function probe(resources: SystemResources): HardwareProbe {
  return { async getSystemResources() { return resources; } };
}

describe("computeFit", () => {
  it("fits on GPU when VRAM is ample", () => {
    const resources: SystemResources = {
      platform: "linux",
      ramTotalBytes: 32 * GB,
      ramFreeBytes: 16 * GB,
      cpuCount: 8,
      gpus: [{ name: "RTX 4090", vramTotalBytes: 24 * GB, vramFreeBytes: 20 * GB }],
    };
    const out = computeFit(resources, 5 * GB);
    expect(out.fits).toBe(true);
    expect(out.target).toBe("gpu");
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
