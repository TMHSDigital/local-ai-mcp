import os from "node:os";

export interface GpuInfo {
  name: string;
  vramTotalBytes?: number;
  vramFreeBytes?: number;
}

export interface SystemResources {
  platform: string;
  ramTotalBytes: number;
  ramFreeBytes: number;
  cpuCount: number;
  gpus: GpuInfo[];
}

export interface HardwareProbe {
  getSystemResources(): Promise<SystemResources>;
}

export function createHardwareProbe(): HardwareProbe {
  return {
    async getSystemResources(): Promise<SystemResources> {
      const platform = os.platform();
      let gpus: GpuInfo[] = [];
      try {
        if (platform === "win32") {
          const mod = await import("./windows.js");
          gpus = mod.probeGpus();
        } else if (platform === "linux") {
          const mod = await import("./linux.js");
          gpus = mod.probeGpus();
        }
      } catch {
        gpus = [];
      }
      return {
        platform,
        ramTotalBytes: os.totalmem(),
        ramFreeBytes: os.freemem(),
        cpuCount: os.cpus().length,
        gpus,
      };
    },
  };
}
