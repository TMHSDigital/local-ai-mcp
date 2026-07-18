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
  /** Total estimated residency: weight + KV cache. */
  requiredBytes: number;
  weightBytes: number;
  kvCacheBytes: number;
  contextLength: number;
  availableBytes: number;
  note: string;
}

export interface FitEstimateOptions {
  /** Context window to size the KV cache for. Default 4096. */
  contextLength?: number;
  /**
   * Parameter count string from catalog/provider (e.g. "7B", "3.8B", "137M").
   * Used to estimate KV-cache bytes; when absent, falls back to weight*0.15.
   */
  parameterSize?: string;
}

const DEFAULT_CONTEXT = 4096;
const BYTES_PER_PARAM_BILLION_PER_1K_CTX = 1024 * 1024; // ~1 MiB / B-params / 1K tokens

/**
 * Parse strings like "7B", "3.8B", "137M", "335M" into billions of parameters.
 * Returns undefined when unparseable.
 */
export function parseParameterBillions(parameterSize: string | undefined): number | undefined {
  if (!parameterSize) return undefined;
  const m = parameterSize.trim().match(/^([\d.]+)\s*([BbMm])$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return m[2].toUpperCase() === "M" ? n / 1000 : n;
}

/**
 * Estimate KV-cache bytes for a given context length.
 * Heuristic: ~1 MiB per billion params per 1K context tokens (fp16-ish GQA).
 * Falls back to 15% of weight size when parameter size is unknown.
 */
export function estimateKvCacheBytes(
  weightBytes: number,
  opts: FitEstimateOptions = {},
): { kvCacheBytes: number; contextLength: number; parameterBillions?: number } {
  const contextLength =
    typeof opts.contextLength === "number" && opts.contextLength > 0
      ? Math.floor(opts.contextLength)
      : DEFAULT_CONTEXT;
  const billions = parseParameterBillions(opts.parameterSize);
  if (billions !== undefined) {
    const kvCacheBytes = Math.round(
      billions * (contextLength / 1024) * BYTES_PER_PARAM_BILLION_PER_1K_CTX,
    );
    return { kvCacheBytes, contextLength, parameterBillions: billions };
  }
  return {
    kvCacheBytes: Math.round(weightBytes * 0.15),
    contextLength,
  };
}

/**
 * Pure fit computation. Prefers GPU VRAM (free) when a GPU reports free VRAM;
 * otherwise falls back to system RAM free. Requires (weight + KV) * 1.2 to fit.
 */
export function computeFit(
  resources: SystemResources,
  weightBytes: number,
  opts: FitEstimateOptions = {},
): FitOutcome {
  const { kvCacheBytes, contextLength } = estimateKvCacheBytes(weightBytes, opts);
  const requiredBytes = weightBytes + kvCacheBytes;
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
        weightBytes,
        kvCacheBytes,
        contextLength,
        availableBytes: bestGpuFree,
        note: `Fits in free GPU VRAM (weight + ~${contextLength}-token KV cache, with 20% headroom).`,
      };
    }
  }

  const ramFree = resources.ramFreeBytes;
  if (headroom <= ramFree) {
    return {
      fits: true,
      target: "cpu",
      requiredBytes,
      weightBytes,
      kvCacheBytes,
      contextLength,
      availableBytes: ramFree,
      note:
        bestGpuFree !== undefined
          ? `Does not fit in free GPU VRAM; fits in system RAM at context ${contextLength} (CPU inference, slower).`
          : `No GPU VRAM info available; fits in system RAM at context ${contextLength} (CPU inference, slower).`,
    };
  }

  return {
    fits: false,
    target: "none",
    requiredBytes,
    weightBytes,
    kvCacheBytes,
    contextLength,
    availableBytes: bestGpuFree !== undefined ? Math.max(bestGpuFree, ramFree) : ramFree,
    note: `Does not fit in free GPU VRAM or system RAM at context ${contextLength} (weight + KV, with 20% headroom).`,
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
