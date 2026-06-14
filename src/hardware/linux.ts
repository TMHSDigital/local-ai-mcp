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
    // fall through to lspci fallback
  }

  try {
    const lspci = spawnSync("lspci", { encoding: "utf8" });
    if (lspci.status === 0 && lspci.stdout) {
      return lspci.stdout
        .split(/\r?\n/)
        .filter((line) => /VGA compatible controller|3D controller/i.test(line))
        .map((line) => ({ name: line.replace(/^\S+\s+/, "").trim() }))
        .filter((g) => g.name);
    }
  } catch {
    // fall through
  }

  return [];
}
