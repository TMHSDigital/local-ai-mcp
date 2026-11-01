import { computeFit, type FitOutcome } from "../fit.js";
import type { SystemResources } from "../hardware/index.js";
import { httpJson } from "../http.js";

const HF = "https://huggingface.co";

interface HfSearchHit {
  id: string;
  downloads?: number;
  likes?: number;
  pipeline_tag?: string;
  tags?: string[];
}

interface HfModelInfo {
  id: string;
  siblings?: Array<{ rfilename: string; size?: number }>;
  gguf?: { total?: number; architecture?: string; context_length?: number };
  pipeline_tag?: string;
}

export interface GgufQuant {
  quant: string;
  sizeBytes: number;
  files: string[];
}

const QUANT_RE = /(?:^|[-_.])((?:I?Q\d(?:_[A-Z0-9]+)*)|F16|BF16|F32)(?:-\d{5}-of-\d{5})?\.gguf$/i;

/** Group a repo's GGUF files by quantization, summing split shards. */
export function groupGgufFiles(siblings: Array<{ rfilename: string; size?: number }>): GgufQuant[] {
  const byQuant = new Map<string, GgufQuant>();
  for (const s of siblings) {
    const file = s.rfilename;
    if (!file.toLowerCase().endsWith(".gguf")) continue;
    if (/mmproj|imatrix/i.test(file)) continue;
    const m = (file.split("/").pop() ?? file).match(QUANT_RE);
    if (!m || !s.size) continue;
    const quant = m[1].toUpperCase();
    const entry = byQuant.get(quant) ?? { quant, sizeBytes: 0, files: [] };
    entry.sizeBytes += s.size;
    entry.files.push(file);
    byQuant.set(quant, entry);
  }
  return [...byQuant.values()].sort((a, b) => a.sizeBytes - b.sizeBytes);
}

export interface QuantFit extends GgufQuant {
  fit: Pick<FitOutcome, "fits" | "target" | "requiredBytes" | "gpuFraction">;
}

/**
 * Best quant for this machine: the largest (highest quality) that fits fully
 * on GPU; else the largest partial offload; else the smallest that runs on CPU.
 */
export function pickBestQuant(quants: QuantFit[]): QuantFit | undefined {
  const by = (t: string) => quants.filter((q) => q.fit.target === t);
  const gpu = by("gpu");
  if (gpu.length) return gpu[gpu.length - 1];
  const partial = by("partial");
  if (partial.length) return partial[partial.length - 1];
  const cpu = by("cpu");
  return cpu[0];
}

export interface HfResult {
  repo: string;
  downloads?: number;
  likes?: number;
  architecture?: string;
  parameterSize?: string;
  maxContextLength?: number;
  quants: QuantFit[];
  best?: { quant: string; sizeBytes: number; target: string; ollama: string; lmstudio: string };
}

const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 60 * 60 * 1000;

async function cachedJson<T>(url: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const value = await httpJson<T>(url, { timeoutMs, signal });
  cache.set(url, { at: Date.now(), value });
  return value;
}

export function clearHfCache(): void {
  cache.clear();
}

/** Search Hugging Face for GGUF repos and annotate each quant with fit. */
export async function searchHuggingFace(
  query: string,
  resources: SystemResources,
  opts: { limit: number; contextLength?: number; timeoutMs: number; signal?: AbortSignal },
): Promise<HfResult[]> {
  const params = new URLSearchParams({
    search: query,
    filter: "gguf",
    sort: "downloads",
    direction: "-1",
    limit: String(opts.limit),
  });
  const hits = await cachedJson<HfSearchHit[]>(`${HF}/api/models?${params}`, opts.timeoutMs, opts.signal);
  const results = await Promise.all(
    (Array.isArray(hits) ? hits : []).slice(0, opts.limit).map(async (hit): Promise<HfResult | undefined> => {
      let info: HfModelInfo;
      try {
        info = await cachedJson<HfModelInfo>(
          `${HF}/api/models/${hit.id.split("/").map(encodeURIComponent).join("/")}?blobs=true`,
          opts.timeoutMs,
          opts.signal,
        );
      } catch {
        return undefined;
      }
      const total = info.gguf?.total;
      const parameterSize = total ? `${(total / 1e9).toFixed(1).replace(/\.0$/, "")}B` : undefined;
      const quants: QuantFit[] = groupGgufFiles(info.siblings ?? []).map((q) => {
        const f = computeFit(resources, q.sizeBytes, { contextLength: opts.contextLength, parameterSize });
        return {
          ...q,
          fit: {
            fits: f.fits,
            target: f.target,
            requiredBytes: f.requiredBytes,
            ...(f.gpuFraction !== undefined ? { gpuFraction: f.gpuFraction } : {}),
          },
        };
      });
      if (quants.length === 0) return undefined;
      const best = pickBestQuant(quants);
      return {
        repo: hit.id,
        downloads: hit.downloads,
        likes: hit.likes,
        ...(info.gguf?.architecture ? { architecture: info.gguf.architecture } : {}),
        ...(parameterSize ? { parameterSize } : {}),
        ...(info.gguf?.context_length ? { maxContextLength: info.gguf.context_length } : {}),
        quants,
        ...(best
          ? {
              best: {
                quant: best.quant,
                sizeBytes: best.sizeBytes,
                target: best.fit.target,
                ollama: `hf.co/${hit.id}:${best.quant}`,
                lmstudio: `${hit.id}@${best.quant.toLowerCase()}`,
              },
            }
          : {}),
      };
    }),
  );
  return results.filter((r): r is HfResult => r !== undefined);
}
