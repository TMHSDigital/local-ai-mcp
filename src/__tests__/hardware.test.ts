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
  // Decision (#96): registry entries are deduplicated by adapter name. The probe
  // output carries no registry path or LUID, and Class\{...}\000N keys persist
  // for removed adapters, so keying on the path would count stale cards. The
  // trade-off: two identical non-NVIDIA cards count once (NVIDIA cards come from
  // nvidia-smi, which lists each physical GPU).
  it("reads 64-bit registry memory sizes, drops virtual adapters, and collapses same-name entries (identical cards count once)", () => {
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

  it("parses a single object instead of an array", () => {
    expect(parseWindowsGpus(JSON.stringify({ Name: "AMD Radeon RX 6800", Bytes: 17163091968, Source: "wmi" }))).toEqual([
      { name: "AMD Radeon RX 6800", vramTotalBytes: 17163091968, source: "wmi" },
    ]);
  });

  it.each([
    ["empty stdout", { stdout: "" }],
    ["garbage stdout", { stdout: "Get-ItemProperty : access denied" }],
    ["a non-zero exit", { status: 1, stdout: "[]" }],
  ])("returns the NVIDIA list only when PowerShell gives %s", async (_label, ps) => {
    const gpus = await probeWindows(
      runner({ "nvidia-smi": { stdout: "NVIDIA GeForce RTX 3060, 12288, 11000\n" }, powershell: ps }),
    );
    expect(gpus.map((g) => [g.name, g.source])).toEqual([["NVIDIA GeForce RTX 3060", "nvidia-smi"]]);
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

  /** Fake sysfs: per-card vendor, PCI slot and VRAM files. */
  function sysfs(cards: Record<string, { vendor: string; slot: string; total?: number; used?: number }>): SysfsReader {
    const files: Record<string, string> = {};
    for (const [card, c] of Object.entries(cards)) {
      const dev = `/sys/class/drm/${card}/device`;
      files[`${dev}/vendor`] = c.vendor;
      if (c.total !== undefined) files[`${dev}/mem_info_vram_total`] = String(c.total);
      if (c.used !== undefined) files[`${dev}/mem_info_vram_used`] = String(c.used);
    }
    const norm = (p: string) => p.replace(/\\/g, "/");
    return {
      list: async () => Object.keys(cards),
      read: async (p) => files[norm(p)],
      resolve: async (p) => `/sys/devices/pci0000:00/${cards[norm(p).split("/")[4]].slot}`,
    };
  }
  const noLspci = runner({});

  it("skips sysfs cards with an unknown vendor id", async () => {
    const gpus = await probeLinux(
      noLspci,
      sysfs({
        card0: { vendor: "0x1af4", slot: "0000:00:01.0", total: 1 * GiB },
        card1: { vendor: "0x1002", slot: "0000:03:00.0", total: 16 * GiB, used: 0 },
      }),
    );
    expect(gpus.map((g) => g.name)).toEqual(["AMD GPU (0000:03:00.0)"]);
  });

  it("counts DRM cards on the same PCI slot once, and same-name cards on different slots twice", async () => {
    const amd = { vendor: "0x1002", total: 24 * GiB, used: 0 };
    const sameSlot = await probeLinux(
      noLspci,
      sysfs({ card0: { ...amd, slot: "0000:03:00.0" }, card1: { ...amd, slot: "0000:03:00.0" } }),
    );
    expect(sameSlot).toHaveLength(1);

    const lspci = runner({
      lspci: {
        stdout: [
          "0000:03:00.0 VGA compatible controller: AMD Navi 31",
          "0000:04:00.0 VGA compatible controller: AMD Navi 31",
        ].join("\n"),
      },
    });
    const twoSlots = await probeLinux(
      lspci,
      sysfs({ card0: { ...amd, slot: "0000:03:00.0" }, card1: { ...amd, slot: "0000:04:00.0" } }),
    );
    expect(twoSlots.map((g) => g.name)).toEqual(["AMD Navi 31", "AMD Navi 31"]);
    expect(twoSlots.reduce((sum, g) => sum + (g.vramTotalBytes ?? 0), 0)).toBe(48 * GiB);
  });

  it("reports total without free VRAM when mem_info_vram_used is missing", async () => {
    const gpus = await probeLinux(noLspci, sysfs({ card0: { vendor: "0x1002", slot: "0000:03:00.0", total: 16 * GiB } }));
    expect(gpus).toEqual([{ name: "AMD GPU (0000:03:00.0)", vramTotalBytes: 16 * GiB, source: "sysfs" }]);
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

  const intel = {
    "sysctl -n hw.memsize": { stdout: String(16 * GiB) },
    "sysctl -n machdep.cpu.brand_string": { stdout: "Intel(R) Core(TM) i9-9980HK" },
    "sysctl -n hw.optional.arm64": { stdout: "0" },
    vm_stat: { stdout: vmStat },
  };

  it("uses system_profiler on Intel Macs and does not report unified memory", async () => {
    const r = await probeDarwin(
      runner({
        ...intel,
        system_profiler: {
          stdout: JSON.stringify({ SPDisplaysDataType: [{ sppci_model: "AMD Radeon Pro 5500M", spdisplays_vram: "8 GB" }] }),
        },
      }),
      16 * GiB,
    );
    expect(r.gpus).toEqual([{ name: "AMD Radeon Pro 5500M", vramTotalBytes: 8 * GiB, source: "system_profiler" }]);
    expect(r.availableBytes).toBe(360000 * 16384);
  });

  it.each([
    ["exits 1", { status: 1, stdout: "" }],
    ["prints invalid JSON", { stdout: "not json" }],
  ])("returns no GPUs when system_profiler %s", async (_label, sp) => {
    const r = await probeDarwin(runner({ ...intel, system_profiler: sp }), 16 * GiB);
    expect(r.gpus).toEqual([]);
  });

  it("omits free VRAM on Apple Silicon when vm_stat fails", async () => {
    const r = await probeDarwin(
      runner({
        "sysctl -n hw.memsize": { stdout: String(16 * GiB) },
        "sysctl -n hw.optional.arm64": { stdout: "1" },
        vm_stat: { status: 1, stdout: "" },
      }),
      16 * GiB,
    );
    expect(r.availableBytes).toBeUndefined();
    expect(r.gpus).toHaveLength(1);
    expect(r.gpus[0]).toMatchObject({ unified: true, vramTotalBytes: Math.round(16 * GiB * 0.67) });
    expect(r.gpus[0]).not.toHaveProperty("vramFreeBytes");
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

  it("returns no GPUs on an unsupported platform", async () => {
    let ran = false;
    const probe = createHardwareProbe({
      platform: "freebsd",
      totalmem: () => 16 * GiB,
      freemem: () => 8 * GiB,
      cpuCount: () => 4,
      run: async () => {
        ran = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const r = await probe.getSystemResources();
    expect(r).toEqual({ platform: "freebsd", ramTotalBytes: 16 * GiB, ramFreeBytes: 8 * GiB, cpuCount: 4, gpus: [] });
    expect(ran).toBe(false);
  });

  it("never throws when probes fail", async () => {
    const probe = createHardwareProbe({ platform: "linux", run: async () => ({ status: 127, stdout: "", stderr: "" }) });
    const r = await probe.getSystemResources();
    expect(Array.isArray(r.gpus)).toBe(true);
  });
});
