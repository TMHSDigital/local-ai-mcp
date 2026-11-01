import { findCatalog } from "../catalog/models.js";
import { sameModel } from "../providers/manager.js";
import type { ModelArchitecture, Provider, RequestOptions } from "../providers/types.js";
import type { ToolContext } from "./context.js";

export interface ModelSizing {
  weightBytes?: number;
  parameterSize?: string;
  architecture?: ModelArchitecture;
  /** Model's maximum/trained context, when known. */
  maxContextLength?: number;
  loaded: boolean;
  residentVramBytes?: number;
  residentRamBytes?: number;
  /** Where weightBytes came from: explicit, provider:<name>, catalog, unknown. */
  source: string;
}

/**
 * Gather everything known about a model's footprint: weight size from the
 * provider listing (or the static catalog), exact architecture from model
 * metadata when the runtime exposes it, and current residency if loaded.
 */
export async function sizeModel(
  ctx: ToolContext,
  provider: Provider | undefined,
  model: string,
  opts: RequestOptions,
  explicit: { sizeBytes?: number; parameterSize?: string } = {},
): Promise<ModelSizing> {
  const out: ModelSizing = { loaded: false, source: "unknown" };
  if (typeof explicit.sizeBytes === "number" && explicit.sizeBytes > 0) {
    out.weightBytes = explicit.sizeBytes;
    out.source = "explicit";
  }
  if (provider) {
    const [models, loaded, detail] = await Promise.all([
      ctx.manager.listModelsCached(provider, opts).catch(() => []),
      provider.listLoaded(opts).catch(() => []),
      provider.modelInfo(model, opts).catch(() => undefined),
    ]);
    const listed = models.find((m) => sameModel(m.id, model));
    if (out.weightBytes === undefined && listed?.sizeBytes) {
      out.weightBytes = listed.sizeBytes;
      out.source = `provider:${provider.name}`;
    }
    out.parameterSize = listed?.parameterSize ?? detail?.parameterSize;
    out.architecture = detail?.architecture;
    out.maxContextLength = detail?.contextLength ?? listed?.contextLength;
    const resident = loaded.find((m) => sameModel(m.id, model));
    if (resident) {
      out.loaded = true;
      if (resident.sizeVramBytes !== undefined) out.residentVramBytes = resident.sizeVramBytes;
      if (resident.sizeBytes !== undefined) {
        out.residentRamBytes = Math.max(0, resident.sizeBytes - (resident.sizeVramBytes ?? 0));
      }
    }
  }
  const cat = findCatalog(model);
  if (out.weightBytes === undefined && cat) {
    out.weightBytes = cat.approxSizeBytes;
    out.source = "catalog";
  }
  out.parameterSize = explicit.parameterSize ?? out.parameterSize ?? cat?.parameterSize;
  return out;
}
