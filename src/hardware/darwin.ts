import type { CommandRunner, GpuInfo } from "./index.js";
import { PROBE_TIMEOUT_MS } from "./index.js";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** Available memory from vm_stat: free + inactive + speculative + purgeable pages. */
export function parseVmStat(stdout: string): number | undefined {
  const pageSize = Number(stdout.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return undefined;
  const pages = (label: string) => {
    const m = stdout.match(new RegExp(`Pages ${label}:\\s+(\\d+)`));
    return m ? Number(m[1]) : 0;
  };
  const total = pages("free") + pages("inactive") + pages("speculative") + pages("purgeable");
  return total > 0 ? total * pageSize : undefined;
}

/**
 * GPU-usable share of unified memory. macOS caps Metal's working set at
 * roughly 2/3 of RAM on smaller machines and ~3/4 on larger ones; an explicit
 * `iogpu.wired_limit_mb` overrides it.
 */
export function metalWorkingSet(memBytes: number, wiredLimitMb?: number): number {
  if (wiredLimitMb && wiredLimitMb > 0) return wiredLimitMb * MiB;
  return Math.round(memBytes * (memBytes >= 36 * GiB ? 0.75 : 0.67));
}

/** Intel Macs: discrete/integrated GPUs from system_profiler JSON. */
export function parseSystemProfilerDisplays(stdout: string): GpuInfo[] {
  const data = JSON.parse(stdout) as { SPDisplaysDataType?: Array<Record<string, unknown>> };
  return (data.SPDisplaysDataType ?? []).map((d) => {
    const vram = String(d.spdisplays_vram ?? d.spdisplays_vram_shared ?? "");
    const m = vram.match(/([\d.]+)\s*(GB|MB)/i);
    const bytes = m ? Number(m[1]) * (m[2].toUpperCase() === "GB" ? GiB : MiB) : undefined;
    return {
      name: String(d.sppci_model ?? d._name ?? "GPU"),
      ...(bytes ? { vramTotalBytes: bytes } : {}),
      source: "system_profiler",
    };
  });
}

export async function probeDarwin(
  run: CommandRunner,
  ramTotalBytes: number,
): Promise<{ gpus: GpuInfo[]; availableBytes?: number }> {
  const sysctl = async (name: string) => {
    const r = await run("sysctl", ["-n", name], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => undefined);
    return r && r.status === 0 ? r.stdout.trim() : undefined;
  };
  const [memsize, brand, arm64, wired, vm] = await Promise.all([
    sysctl("hw.memsize"),
    sysctl("machdep.cpu.brand_string"),
    sysctl("hw.optional.arm64"),
    sysctl("iogpu.wired_limit_mb"),
    run("vm_stat", [], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => undefined),
  ]);
  const mem = Number(memsize) > 0 ? Number(memsize) : ramTotalBytes;
  const availableBytes = vm && vm.status === 0 ? parseVmStat(vm.stdout) : undefined;

  if (arm64 === "1") {
    const total = metalWorkingSet(mem, Number(wired) || undefined);
    const free = availableBytes !== undefined ? Math.min(availableBytes, total) : undefined;
    return {
      availableBytes,
      gpus: [
        {
          name: brand || "Apple Silicon GPU",
          vramTotalBytes: total,
          ...(free !== undefined ? { vramFreeBytes: free } : {}),
          unified: true,
          source: "sysctl",
        },
      ],
    };
  }

  const sp = await run("system_profiler", ["SPDisplaysDataType", "-json"], { timeoutMs: PROBE_TIMEOUT_MS * 2 }).catch(
    () => undefined,
  );
  let gpus: GpuInfo[] = [];
  if (sp && sp.status === 0) {
    try {
      gpus = parseSystemProfilerDisplays(sp.stdout);
    } catch {
      gpus = [];
    }
  }
  return { gpus, availableBytes };
}
