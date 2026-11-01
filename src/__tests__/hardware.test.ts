import { describe, expect, it } from "vitest";
import { probeDarwin, metalWorkingSet, parseSystemProfilerDisplays, parseVmStat } from "../hardware/darwin.js";
import { createHardwareProbe, withEstimatedFree, type CommandRunner } from "../hardware/index.js";
import { parseLspci, probeGpus as probeLinux, type SysfsReader } from "../hardware/linux.js";
import { parseNvidiaSmi } from "../hardware/nvidia.js";
import { parseWindowsGpus, probeGpus as probeWindows } from "../hardware/windows.js";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

function runner(map: Record<string, { status?: number; stdout: string }>): CommandRunner {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    const hit = Object.entries(map).find(([k]) => key.startsWith(k));
    if (!hit) return { status: 127, stdout: "", stderr: "not found" };
    return { status: hit[1].status ?? 0, stdout: hit[1].stdout, stderr: "" };
  };
}

describe("nvidia-smi", () => {
  it("parses multiple GPUs", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4090, 24564, 22000\nNVIDIA RTX A4000, 16376, [N/A]\n")).toEqual([
      { name: "NVIDIA GeForce RTX 4090", vramTotalBytes: 24564 * MiB, vramFreeBytes: 22000 * MiB, source: "nvidia-smi" },
      { name: "NVIDIA RTX A4000", vramTotalBytes: 16376 * MiB, vramFreeBytes: undefined, source: "nvidia-smi" },
    ]);
  });
});

describe("windows", () => {
  it("reads 64-bit registry memory sizes and drops virtual adapters", () => {
    const out = parseWindowsGpus(
      JSON.stringify([
        { Name: "AMD Radeon RX 7900 XTX", Bytes: 25753026560, Source: "registry" },
        { Name: "Microsoft Basic Display Adapter", Bytes: 0, Source: "registry" },
        { Name: "AMD Radeon RX 7900 XTX", Bytes: 25753026560, Source: "registry" },
      ]),
    );
    expect(out).toEqual([{ name: "AMD Radeon RX 7900 XTX", vramTotalBytes: 25753026560, source: "registry" }]);
  });

  it("keeps nvidia-smi for NVIDIA and registry for other vendors", async () => {
    const gpus = await probeWindows(
      runner({
        "nvidia-smi": { stdout: "NVIDIA GeForce RTX 3060, 12288, 11000\n" },
        powershell: {
          stdout: JSON.stringify([
            { Name: "NVIDIA GeForce RTX 3060", Bytes: 12884901888 },
            { Name: "Intel(R) UHD Graphics 770", Bytes: 134217728 },
          ]),
        },
      }),
    );
    expect(gpus.map((g) => [g.name, g.source])).toEqual([
      ["NVIDIA GeForce RTX 3060", "nvidia-smi"],
      ["Intel(R) UHD Graphics 770", "registry"],
    ]);
  });
});

describe("linux", () => {
  it("parses lspci -D", () => {
    expect(
      parseLspci(
        "0000:03:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XT/7900 XTX]\n0000:00:02.0 Display controller: Intel Corporation Device a780\n",
      ).get("0000:03:00.0"),
    ).toMatch(/Navi 31/);
  });

  it("reads amdgpu VRAM total and free from sysfs", async () => {
    const files: Record<string, string> = {
      "/sys/class/drm/card1/device/vendor": "0x1002",
      "/sys/class/drm/card1/device/mem_info_vram_total": String(24 * GiB),
      "/sys/class/drm/card1/device/mem_info_vram_used": String(2 * GiB),
    };
    const fs: SysfsReader = {
      list: async () => ["card1", "card1-DP-1", "renderD128"],
      read: async (p) => files[p.replace(/\\/g, "/")],
      resolve: async () => "/sys/devices/pci0000:00/0000:03:00.0",
    };
    const gpus = await probeLinux(
      runner({ lspci: { stdout: "0000:03:00.0 VGA compatible controller: AMD Navi 31\n" } }),
      fs,
    );
    expect(gpus).toEqual([{ name: "AMD Navi 31", vramTotalBytes: 24 * GiB, vramFreeBytes: 22 * GiB, source: "sysfs" }]);
  });
});

describe("darwin", () => {
  const vmStat = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                               100000.",
    "Pages active:                             500000.",
    "Pages inactive:                           200000.",
    "Pages speculative:                         50000.",
    "Pages purgeable:                           10000.",
  ].join("\n");

  it("parses vm_stat available memory", () => {
    expect(parseVmStat(vmStat)).toBe(360000 * 16384);
  });

  it("estimates the Metal working set", () => {
    expect(metalWorkingSet(16 * GiB)).toBe(Math.round(16 * GiB * 0.67));
    expect(metalWorkingSet(64 * GiB)).toBe(48 * GiB);
    expect(metalWorkingSet(64 * GiB, 57344)).toBe(56 * GiB);
  });

  it("reports Apple Silicon as a unified GPU", async () => {
    const r = await probeDarwin(
      runner({
        "sysctl -n hw.memsize": { stdout: String(32 * GiB) },
        "sysctl -n machdep.cpu.brand_string": { stdout: "Apple M3 Max" },
        "sysctl -n hw.optional.arm64": { stdout: "1" },
        "sysctl -n iogpu.wired_limit_mb": { stdout: "0" },
        vm_stat: { stdout: vmStat },
      }),
      32 * GiB,
    );
    expect(r.availableBytes).toBe(360000 * 16384);
    expect(r.gpus).toEqual([
      {
        name: "Apple M3 Max",
        vramTotalBytes: Math.round(32 * GiB * 0.67),
        vramFreeBytes: 360000 * 16384,
        unified: true,
        source: "sysctl",
      },
    ]);
  });

  it("parses system_profiler for Intel Macs", () => {
    expect(
      parseSystemProfilerDisplays(JSON.stringify({ SPDisplaysDataType: [{ sppci_model: "AMD Radeon Pro 5500M", spdisplays_vram: "8 GB" }] })),
    ).toEqual([{ name: "AMD Radeon Pro 5500M", vramTotalBytes: 8 * GiB, source: "system_profiler" }]);
  });
});

describe("createHardwareProbe", () => {
  it("uses darwin available memory and estimates free VRAM when only total is known", async () => {
    const probe = createHardwareProbe({
      platform: "darwin",
      totalmem: () => 32 * GiB,
      freemem: () => 1 * GiB,
      cpuCount: () => 12,
      run: runner({
        "sysctl -n hw.optional.arm64": { stdout: "1" },
        "sysctl -n hw.memsize": { stdout: String(32 * GiB) },
        vm_stat: { stdout: "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 65536.\n" },
      }),
    });
    const r = await probe.getSystemResources();
    expect(r.ramFreeBytes).toBe(1 * GiB);
    expect(r.gpus[0].unified).toBe(true);
  });

  it("withEstimatedFree only applies to discrete-sized GPUs", () => {
    expect(withEstimatedFree({ name: "x", vramTotalBytes: 16 * GiB, source: "registry" })).toMatchObject({
      vramFreeBytes: Math.round(16 * GiB * 0.9),
      freeEstimated: true,
    });
    expect(withEstimatedFree({ name: "igpu", vramTotalBytes: 128 * MiB, source: "registry" }).vramFreeBytes).toBeUndefined();
  });

  it("never throws when probes fail", async () => {
    const probe = createHardwareProbe({ platform: "linux", run: async () => ({ status: 127, stdout: "", stderr: "" }) });
    const r = await probe.getSystemResources();
    expect(Array.isArray(r.gpus)).toBe(true);
  });
});
