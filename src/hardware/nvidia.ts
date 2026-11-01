import type { CommandRunner, GpuInfo } from "./index.js";
import { PROBE_TIMEOUT_MS } from "./index.js";

const MB = 1024 * 1024;

/** Parse `nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(stdout: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",").map((p) => p.trim());
    if (parts.length < 3) continue;
    const [name, totalMb, freeMb] = parts;
    const total = Number(totalMb);
    const free = Number(freeMb);
    gpus.push({
      name,
      vramTotalBytes: totalMb !== "" && Number.isFinite(total) ? total * MB : undefined,
      vramFreeBytes: freeMb !== "" && Number.isFinite(free) ? free * MB : undefined,
      source: "nvidia-smi",
    });
  }
  return gpus;
}

export async function probeNvidia(run: CommandRunner): Promise<GpuInfo[]> {
  const res = await run(
    "nvidia-smi",
    ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
    { timeoutMs: PROBE_TIMEOUT_MS },
  ).catch(() => undefined);
  if (!res || res.status !== 0 || !res.stdout.trim()) return [];
  return parseNvidiaSmi(res.stdout);
}
