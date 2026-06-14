import { spawnSync } from "node:child_process";
import type { GpuInfo } from "./index.js";

const MB = 1024 * 1024;

function parseNvidiaSmi(stdout: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",").map((p) => p.trim());
    if (parts.length < 3) continue;
    const [name, totalMb, freeMb] = parts;
    gpus.push({
      name,
      vramTotalBytes: Number.isFinite(Number(totalMb)) ? Number(totalMb) * MB : undefined,
      vramFreeBytes: Number.isFinite(Number(freeMb)) ? Number(freeMb) * MB : undefined,
    });
  }
  return gpus;
}

export function probeGpus(): GpuInfo[] {
  try {
    const smi = spawnSync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
      { encoding: "utf8" },
    );
    if (smi.status === 0 && smi.stdout && smi.stdout.trim()) {
      const gpus = parseNvidiaSmi(smi.stdout);
      if (gpus.length > 0) return gpus;
    }
  } catch {
    // fall through to PowerShell fallback
  }

  try {
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8" },
    );
    if (ps.status === 0 && ps.stdout && ps.stdout.trim()) {
      const parsed: unknown = JSON.parse(ps.stdout);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list
        .map((item) => {
          const obj = item as { Name?: string; AdapterRAM?: number };
          return {
            name: obj.Name ?? "Unknown GPU",
            vramTotalBytes:
              typeof obj.AdapterRAM === "number" && obj.AdapterRAM > 0
                ? obj.AdapterRAM
                : undefined,
          };
        })
        .filter((g) => g.name);
    }
  } catch {
    // fall through
  }

  return [];
}
