import type { CommandRunner, GpuInfo } from "./index.js";
import { PROBE_TIMEOUT_MS } from "./index.js";
import { probeNvidia } from "./nvidia.js";

/**
 * Reads adapter memory from the display-class registry keys. Unlike
 * Win32_VideoController.AdapterRAM (a uint32 capped at 4 GB),
 * HardwareInformation.qwMemorySize is 64-bit. Falls back to AdapterRAM.
 */
export const WINDOWS_GPU_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$out=@()",
  "Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | ForEach-Object {",
  "  $m=$_.'HardwareInformation.qwMemorySize'",
  "  if ($m -eq $null) { $m=$_.'HardwareInformation.MemorySize' }",
  "  if ($m -is [byte[]]) { $m=[BitConverter]::ToUInt32($m,0) }",
  "  if ($_.DriverDesc) { $out += [pscustomobject]@{Name=$_.DriverDesc; Bytes=[uint64]$m; Source='registry'} }",
  "}",
  "if ($out.Count -eq 0) { Get-CimInstance Win32_VideoController | ForEach-Object { $out += [pscustomobject]@{Name=$_.Name; Bytes=[uint64]$_.AdapterRAM; Source='wmi'} } }",
  "$out | ConvertTo-Json -Compress",
].join("\n");

export function parseWindowsGpus(stdout: string): GpuInfo[] {
  const parsed: unknown = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const seen = new Set<string>();
  const gpus: GpuInfo[] = [];
  for (const item of list) {
    const obj = item as { Name?: string; Bytes?: number; Source?: string };
    const name = obj.Name?.trim();
    if (!name || seen.has(name)) continue;
    // Virtual/remote adapters carry no usable memory.
    if (/basic (display|render)|remote display|virtual/i.test(name)) continue;
    seen.add(name);
    gpus.push({
      name,
      vramTotalBytes: typeof obj.Bytes === "number" && obj.Bytes > 0 ? obj.Bytes : undefined,
      source: obj.Source ?? "registry",
    });
  }
  return gpus;
}

export async function probeGpus(run: CommandRunner): Promise<GpuInfo[]> {
  const nvidia = await probeNvidia(run);
  let others: GpuInfo[] = [];
  const ps = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_GPU_SCRIPT], {
    timeoutMs: PROBE_TIMEOUT_MS,
  }).catch(() => undefined);
  if (ps && ps.status === 0 && ps.stdout.trim()) {
    try {
      others = parseWindowsGpus(ps.stdout);
    } catch {
      others = [];
    }
  }
  if (nvidia.length > 0) {
    // nvidia-smi has live free VRAM; keep registry entries only for other vendors.
    return [...nvidia, ...others.filter((g) => !/nvidia/i.test(g.name))];
  }
  return others;
}
