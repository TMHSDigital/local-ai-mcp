import type { SystemResources } from "../hardware/index.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Aggregate per-provider results, capturing errors per provider rather than
 * failing the whole call.
 */
export async function aggregate<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providers: Array<{ id: string }>,
  fn: (p: any) => Promise<T>,
): Promise<Record<string, T | { error: string }>> {
  const entries = await Promise.all(
    providers.map(async (p) => {
      try {
        return [p.id, await fn(p)] as const;
      } catch (err) {
        return [p.id, { error: errMsg(err) }] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

export interface FitOutcome {
  fits: boolean;
  target: "gpu" | "cpu" | "none";
  requiredBytes: number;
  availableBytes: number;
  note: string;
}

/**
 * Pure fit computation. Prefers GPU VRAM (free) when a GPU reports free VRAM;
 * otherwise falls back to system RAM free. Requires requiredBytes * 1.2 to fit.
 */
export function computeFit(resources: SystemResources, requiredBytes: number): FitOutcome {
  const headroom = requiredBytes * 1.2;

  const gpuFree = resources.gpus
    .map((g) => g.vramFreeBytes)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const bestGpuFree = gpuFree.length > 0 ? Math.max(...gpuFree) : undefined;

  if (bestGpuFree !== undefined) {
    if (headroom <= bestGpuFree) {
      return {
        fits: true,
        target: "gpu",
        requiredBytes,
        availableBytes: bestGpuFree,
        note: "Fits in free GPU VRAM (with 20% headroom).",
      };
    }
  }

  const ramFree = resources.ramFreeBytes;
  if (headroom <= ramFree) {
    return {
      fits: true,
      target: "cpu",
      requiredBytes,
      availableBytes: ramFree,
      note:
        bestGpuFree !== undefined
          ? "Does not fit in free GPU VRAM; fits in system RAM (CPU inference, slower)."
          : "No GPU VRAM info available; fits in system RAM (CPU inference, slower).",
    };
  }

  return {
    fits: false,
    target: "none",
    requiredBytes,
    availableBytes: bestGpuFree !== undefined ? Math.max(bestGpuFree, ramFree) : ramFree,
    note: "Does not fit in free GPU VRAM or system RAM (with 20% headroom).",
  };
}

/**
 * Destructive-action confirm gate for remove_model. Refuses unless confirm === true.
 */
export async function removeModelGuarded(
  confirm: boolean,
  model: string,
  remove: () => Promise<unknown>,
): Promise<{ refused: true; message: string } | { refused: false; result: unknown }> {
  if (confirm !== true) {
    return {
      refused: true,
      message: `Refusing to remove "${model}": this is a destructive action. Pass confirm:true to proceed.`,
    };
  }
  return { refused: false, result: await remove() };
}
