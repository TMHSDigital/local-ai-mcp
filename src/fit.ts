import type { SystemResources } from "./hardware/index.js";
import type { ModelArchitecture } from "./providers/types.js";

export const KV_CACHE_TYPES = ["f16", "q8_0", "q4_0"] as const;
export type KvCacheType = (typeof KV_CACHE_TYPES)[number];

/** Bytes per KV element. q8_0 / q4_0 are GGML block formats (34 / 18 bytes per 32). */
const KV_BYTES: Record<KvCacheType, number> = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 };

export const DEFAULT_CONTEXT = 4096;
/** Weight + KV must fit with this much headroom (compute buffers, fragmentation). */
export const HEADROOM = 1.2;
/** Below this GPU share, partial offload is not worth calling out. */
const MIN_PARTIAL_FRACTION = 0.1;

export interface FitEstimateOptions {
  /** Context window to size the KV cache for. Default 4096. */
  contextLength?: number;
  /** Parameter count string (e.g. "7B", "3.8B", "137M") for the heuristic. */
  parameterSize?: string;
  /** Exact layer shape (from Ollama /api/show), preferred over heuristics. */
  architecture?: ModelArchitecture;
  kvCacheType?: KvCacheType;
  /** Bytes this model already occupies in VRAM (it is loaded), credited back. */
  residentVramBytes?: number;
  /** Bytes this model already occupies in system RAM, credited back. */
  residentRamBytes?: number;
}

export type KvEstimateMethod = "architecture" | "parameters" | "weight-ratio";

export interface FitOutcome {
  fits: boolean;
  /** gpu: fully in VRAM; partial: split GPU/CPU; cpu: system RAM only; none: does not fit. */
  target: "gpu" | "partial" | "cpu" | "none";
  /** Estimated residency: weight + KV cache (before headroom). */
  requiredBytes: number;
  weightBytes: number;
  kvCacheBytes: number;
  contextLength: number;
  kvCacheType: KvCacheType;
  kvEstimate: KvEstimateMethod;
  /** Free VRAM summed across GPUs (plus credit for this model if loaded). */
  gpuAvailableBytes: number;
  ramAvailableBytes: number;
  /** The budget the target was judged against. */
  availableBytes: number;
  /** Share of the model expected on the GPU when target is "partial". */
  gpuFraction?: number;
  gpuCount: number;
  unifiedMemory: boolean;
  note: string;
}

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
 * KV-cache bytes for a context length.
 * - architecture: 2 (K,V) x layers x kvHeads x headDim x ctx x bytes/elem — exact.
 * - parameters: fp16 KV per token ~= 40 KiB x B^0.6. Fitted to GQA-era models
 *   (Llama 3.2 1B ~32 KiB, Llama 3.1 8B 128 KiB, Llama 3.1 70B 320 KiB per
 *   token); errs high for very large models.
 * - weight-ratio: last resort, 15% of weights at 4K context, scaled by context.
 */
export function estimateKvCacheBytes(
  weightBytes: number,
  opts: FitEstimateOptions = {},
): { kvCacheBytes: number; contextLength: number; method: KvEstimateMethod; parameterBillions?: number } {
  const contextLength =
    typeof opts.contextLength === "number" && opts.contextLength > 0
      ? Math.floor(opts.contextLength)
      : DEFAULT_CONTEXT;
  const bytesPerElem = KV_BYTES[opts.kvCacheType ?? "f16"];
  const a = opts.architecture;
  if (a && a.layers > 0 && a.kvHeads > 0 && a.keyLength > 0 && a.valueLength > 0) {
    const perToken = a.layers * a.kvHeads * (a.keyLength + a.valueLength) * bytesPerElem;
    return { kvCacheBytes: Math.round(perToken * contextLength), contextLength, method: "architecture" };
  }
  const billions = parseParameterBillions(opts.parameterSize);
  if (billions !== undefined) {
    const perTokenF16 = 40 * 1024 * billions ** 0.6;
    return {
      kvCacheBytes: Math.round(perTokenF16 * (bytesPerElem / 2) * contextLength),
      contextLength,
      method: "parameters",
      parameterBillions: billions,
    };
  }
  return {
    kvCacheBytes: Math.round(weightBytes * 0.15 * (contextLength / DEFAULT_CONTEXT) * (bytesPerElem / 2)),
    contextLength,
    method: "weight-ratio",
  };
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

/**
 * Pure fit computation. Sums free VRAM across GPUs (runtimes split layers
 * across cards), allows partial GPU/CPU offload, and treats Apple Silicon
 * unified memory as one pool. Requires (weight + KV) x 1.2 to fit.
 */
export function computeFit(
  resources: SystemResources,
  weightBytes: number,
  opts: FitEstimateOptions = {},
): FitOutcome {
  const kv = estimateKvCacheBytes(weightBytes, opts);
  const requiredBytes = weightBytes + kv.kvCacheBytes;
  const need = requiredBytes * HEADROOM;

  const gpus = resources.gpus.filter((g) => typeof g.vramFreeBytes === "number" && g.vramFreeBytes > 0);
  const unifiedMemory = resources.gpus.some((g) => g.unified);
  const gpuAvailableBytes =
    gpus.reduce((sum, g) => sum + (g.vramFreeBytes ?? 0), 0) + (opts.residentVramBytes ?? 0);
  const ramAvailableBytes = resources.ramFreeBytes + (opts.residentRamBytes ?? 0);
  const estimatedFree = gpus.some((g) => g.freeEstimated);

  const base = {
    requiredBytes,
    weightBytes,
    kvCacheBytes: kv.kvCacheBytes,
    contextLength: kv.contextLength,
    kvCacheType: opts.kvCacheType ?? "f16",
    kvEstimate: kv.method,
    gpuAvailableBytes,
    ramAvailableBytes,
    gpuCount: gpus.length,
    unifiedMemory,
  } as const;
  const ctxNote = `${kv.contextLength}-token context`;
  const freeNote = estimatedFree ? " (free VRAM estimated from total)" : "";

  if (gpuAvailableBytes > 0 && need <= gpuAvailableBytes) {
    const split = gpus.length > 1 ? `, split across ${gpus.length} GPUs` : "";
    return {
      ...base,
      fits: true,
      target: "gpu",
      availableBytes: gpuAvailableBytes,
      note: `Fits fully in ${unifiedMemory ? "GPU-usable unified memory" : "free VRAM"}${split}: needs ~${gb(need)} of ${gb(gpuAvailableBytes)} at ${ctxNote}${freeNote}.`,
    };
  }

  // Unified memory: CPU and GPU share one pool, so the RAM budget is the ceiling.
  const partialBudget = unifiedMemory ? ramAvailableBytes : gpuAvailableBytes + ramAvailableBytes;
  if (gpuAvailableBytes > 0 && need <= partialBudget) {
    const gpuFraction = Math.min(1, gpuAvailableBytes / need);
    if (gpuFraction >= MIN_PARTIAL_FRACTION) {
      return {
        ...base,
        fits: true,
        target: "partial",
        availableBytes: partialBudget,
        gpuFraction: Number(gpuFraction.toFixed(2)),
        note: `Does not fit in VRAM alone; ~${Math.round(gpuFraction * 100)}% of layers on GPU, the rest on CPU (slower) at ${ctxNote}${freeNote}.`,
      };
    }
  }

  if (need <= ramAvailableBytes) {
    return {
      ...base,
      fits: true,
      target: "cpu",
      availableBytes: ramAvailableBytes,
      note:
        gpuAvailableBytes > 0
          ? `Too large for useful GPU offload; fits in system RAM at ${ctxNote} (CPU inference, slower).`
          : `No GPU VRAM info available; fits in system RAM at ${ctxNote} (CPU inference, slower).`,
    };
  }

  return {
    ...base,
    fits: false,
    target: "none",
    availableBytes: Math.max(partialBudget, ramAvailableBytes),
    note: `Does not fit: needs ~${gb(need)} (weight + KV at ${ctxNote}, with 20% headroom); ${gb(gpuAvailableBytes)} VRAM and ${gb(ramAvailableBytes)} RAM available. Try a smaller quant, shorter context, or kvCacheType q8_0.`,
  };
}
