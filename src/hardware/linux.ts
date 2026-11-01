import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CommandRunner, GpuInfo } from "./index.js";
import { PROBE_TIMEOUT_MS } from "./index.js";
import { probeNvidia } from "./nvidia.js";

const VENDORS: Record<string, string> = {
  "0x1002": "AMD",
  "0x8086": "Intel",
  "0x10de": "NVIDIA",
};

export interface SysfsReader {
  list(dir: string): Promise<string[]>;
  read(path: string): Promise<string | undefined>;
  resolve(path: string): Promise<string | undefined>;
}

export const nodeSysfs: SysfsReader = {
  list: (dir) => readdir(dir).catch(() => []),
  read: (path) => readFile(path, "utf8").then((s) => s.trim()).catch(() => undefined),
  resolve: (path) => realpath(path).catch(() => undefined),
};

/** Map PCI slot -> device name from `lspci -D`. */
export function parseLspci(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(?:VGA compatible controller|3D controller|Display controller):\s*(.+)$/i);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

/**
 * DRM sysfs probe. amdgpu exposes mem_info_vram_total / mem_info_vram_used,
 * which gives AMD (ROCm) cards real total and free VRAM.
 */
export type SysfsGpu = GpuInfo & { vendor: string };

export async function probeSysfs(fs: SysfsReader, names: Map<string, string>): Promise<SysfsGpu[]> {
  const root = "/sys/class/drm";
  const cards = (await fs.list(root)).filter((c) => /^card\d+$/.test(c));
  const gpus: SysfsGpu[] = [];
  const seenSlots = new Set<string>();
  for (const card of cards) {
    const dev = join(root, card, "device");
    const vendorId = await fs.read(join(dev, "vendor"));
    const vendor = vendorId ? VENDORS[vendorId.toLowerCase()] : undefined;
    if (!vendor) continue;
    const slot = basename((await fs.resolve(dev)) ?? card);
    if (seenSlots.has(slot)) continue;
    seenSlots.add(slot);
    const total = Number(await fs.read(join(dev, "mem_info_vram_total")));
    const used = Number(await fs.read(join(dev, "mem_info_vram_used")));
    const hasTotal = Number.isFinite(total) && total > 0;
    gpus.push({
      name: names.get(slot) ?? `${vendor} GPU (${slot})`,
      vendor,
      ...(hasTotal ? { vramTotalBytes: total } : {}),
      ...(hasTotal && Number.isFinite(used) ? { vramFreeBytes: Math.max(0, total - used) } : {}),
      source: "sysfs",
    });
  }
  return gpus;
}

export async function probeGpus(run: CommandRunner, fs: SysfsReader = nodeSysfs): Promise<GpuInfo[]> {
  const nvidia = await probeNvidia(run);
  const lspci = await run("lspci", ["-D"], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => undefined);
  const names = lspci && lspci.status === 0 ? parseLspci(lspci.stdout) : new Map<string, string>();
  const sysfs = await probeSysfs(fs, names).catch(() => [] as SysfsGpu[]);
  // nvidia-smi is authoritative for NVIDIA cards; sysfs covers AMD/Intel.
  const others: GpuInfo[] = sysfs
    .filter((g) => !(nvidia.length > 0 && g.vendor === "NVIDIA"))
    .map(({ vendor: _vendor, ...g }) => g);
  if (nvidia.length > 0 || others.length > 0) return [...nvidia, ...others];
  // Last resort: names only.
  return [...names.values()].map((name) => ({ name, source: "lspci" }));
}
