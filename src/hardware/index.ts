import os from "node:os";
import { runCommand, type ExecOptions, type ExecResult } from "../exec.js";

export interface GpuInfo {
  name: string;
  vramTotalBytes?: number;
  vramFreeBytes?: number;
  /** True when free VRAM is estimated (the source reports total only). */
  freeEstimated?: boolean;
  /** Unified memory shared with the CPU (Apple Silicon). */
  unified?: boolean;
  /** Where the numbers came from: nvidia-smi, sysfs, registry, wmi, sysctl, lspci, ... */
  source: string;
}

export interface SystemResources {
  platform: string;
  ramTotalBytes: number;
  /** Memory available for new allocations (MemAvailable / vm_stat on macOS). */
  ramFreeBytes: number;
  cpuCount: number;
  gpus: GpuInfo[];
}

export interface HardwareProbe {
  getSystemResources(): Promise<SystemResources>;
}

export type CommandRunner = (cmd: string, args: string[], opts: ExecOptions) => Promise<ExecResult>;

export interface ProbeDeps {
  run: CommandRunner;
  platform: string;
  totalmem: () => number;
  freemem: () => number;
  cpuCount: () => number;
}

/** Each probe subprocess gets this long before it is killed. */
export const PROBE_TIMEOUT_MS = 5000;

const defaultDeps: ProbeDeps = {
  run: runCommand,
  platform: os.platform(),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  cpuCount: () => os.cpus().length,
};

/**
 * When a source reports only total VRAM for a discrete GPU, assume ~90% of it
 * is free so fit checks still consider the GPU (flagged freeEstimated).
 */
export function withEstimatedFree(gpu: GpuInfo): GpuInfo {
  if (gpu.vramFreeBytes !== undefined || gpu.vramTotalBytes === undefined) return gpu;
  if (gpu.vramTotalBytes < 2 * 1024 ** 3) return gpu; // integrated / tiny carve-outs
  return { ...gpu, vramFreeBytes: Math.round(gpu.vramTotalBytes * 0.9), freeEstimated: true };
}

export function createHardwareProbe(overrides: Partial<ProbeDeps> = {}): HardwareProbe {
  const deps: ProbeDeps = { ...defaultDeps, ...overrides };
  return {
    async getSystemResources(): Promise<SystemResources> {
      const base: SystemResources = {
        platform: deps.platform,
        ramTotalBytes: deps.totalmem(),
        ramFreeBytes: deps.freemem(),
        cpuCount: deps.cpuCount(),
        gpus: [],
      };
      try {
        if (deps.platform === "win32") {
          const mod = await import("./windows.js");
          base.gpus = await mod.probeGpus(deps.run);
        } else if (deps.platform === "linux") {
          const mod = await import("./linux.js");
          base.gpus = await mod.probeGpus(deps.run);
        } else if (deps.platform === "darwin") {
          const mod = await import("./darwin.js");
          const mac = await mod.probeDarwin(deps.run, base.ramTotalBytes);
          base.gpus = mac.gpus;
          if (mac.availableBytes !== undefined) base.ramFreeBytes = mac.availableBytes;
        }
      } catch {
        base.gpus = [];
      }
      base.gpus = base.gpus.map(withEstimatedFree);
      return base;
    },
  };
}
