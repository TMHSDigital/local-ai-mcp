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
  /** Drop cached GPU numbers, e.g. after a model load or unload changed free VRAM. */
  invalidate?(): void;
}

export type CommandRunner = (cmd: string, args: string[], opts: ExecOptions) => Promise<ExecResult>;

export interface ProbeDeps {
  run: CommandRunner;
  platform: string;
  totalmem: () => number;
  freemem: () => number;
  cpuCount: () => number;
  /** How long GPU probe results are reused. 0 re-probes every call. */
  cacheTtlMs: number;
  now: () => number;
}

/**
 * GPU probes spawn processes (nvidia-smi, PowerShell, system_profiler) that
 * cost hundreds of ms each, and most tools need them. Results are reused for
 * this long; RAM is always read fresh because it is cheap.
 */
export const GPU_CACHE_TTL_MS = 5000;

/** Each probe subprocess gets this long before it is killed. */
export const PROBE_TIMEOUT_MS = 5000;

/**
 * Runs probe commands from the OS temp dir, not the server's cwd. GPU tools
 * can write files relative to the working directory (the NVIDIA driver
 * creates `NVIDIA Corporation/umdlogs/` there on Windows), and the server's
 * cwd is often the user's project.
 */
export const runProbeCommand: CommandRunner = (cmd, args, opts) =>
  runCommand(cmd, args, { ...opts, cwd: os.tmpdir() });

const defaultDeps: ProbeDeps = {
  run: runProbeCommand,
  platform: os.platform(),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  cpuCount: () => os.cpus().length,
  cacheTtlMs: GPU_CACHE_TTL_MS,
  now: () => Date.now(),
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

interface GpuProbe {
  gpus: GpuInfo[];
  /** macOS: memory available to new allocations, from vm_stat. */
  availableBytes?: number;
}

async function probeGpuState(deps: ProbeDeps): Promise<GpuProbe> {
  try {
    if (deps.platform === "win32") {
      const mod = await import("./windows.js");
      return { gpus: await mod.probeGpus(deps.run) };
    }
    if (deps.platform === "linux") {
      const mod = await import("./linux.js");
      return { gpus: await mod.probeGpus(deps.run) };
    }
    if (deps.platform === "darwin") {
      const mod = await import("./darwin.js");
      return await mod.probeDarwin(deps.run, deps.totalmem());
    }
  } catch {
    // fall through: no GPU information
  }
  return { gpus: [] };
}

export function createHardwareProbe(overrides: Partial<ProbeDeps> = {}): HardwareProbe {
  const deps: ProbeDeps = { ...defaultDeps, ...overrides };
  let cached: { at: number; value: Promise<GpuProbe> } | undefined;
  const gpuState = (): Promise<GpuProbe> => {
    const now = deps.now();
    if (cached && deps.cacheTtlMs > 0 && now - cached.at < deps.cacheTtlMs) return cached.value;
    // Concurrent callers share this one in-flight probe.
    const value = probeGpuState(deps);
    cached = { at: now, value };
    return value;
  };
  return {
    async getSystemResources(): Promise<SystemResources> {
      const state = await gpuState();
      return {
        platform: deps.platform,
        ramTotalBytes: deps.totalmem(),
        ramFreeBytes: state.availableBytes ?? deps.freemem(),
        cpuCount: deps.cpuCount(),
        gpus: state.gpus.map(withEstimatedFree),
      };
    },
    invalidate() {
      cached = undefined;
    },
  };
}
