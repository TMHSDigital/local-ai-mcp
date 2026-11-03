import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Ajv, type ValidateFunction } from "ajv";
import { z } from "zod";
import { findCatalog, tasksForModel, type CatalogTask } from "../catalog/models.js";
import { computeFit, parseParameterBillions } from "../fit.js";
import type {
  ChatMessage,
  CompletionParams,
  CompletionResult,
  LoadedModelInfo,
  ModelSummary,
  Provider,
} from "../providers/types.js";
import { rankSuggestions } from "./catalog.js";
import { machineFingerprint, type SpeedRecord } from "../speed-cache.js";
import type { ToolContext } from "./context.js";
import { anyRecord, type Extra, ok, progressSender, providerArg, reqOpts, safe } from "./helpers.js";
import { ensureModel } from "./lifecycle.js";

const contentPart = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    data: z.string().optional().describe("Base64 image data (no data: prefix)"),
    mimeType: z.string().optional(),
    url: z.string().optional().describe("Image URL or data: URL"),
  }),
]);

const messageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(contentPart)]),
});

const responseFormatSchema = z.union([
  z.object({ type: z.literal("json_object") }),
  z.object({
    type: z.literal("json_schema"),
    schema: z.record(z.string(), z.unknown()).describe("JSON Schema the output must satisfy"),
    name: z.string().optional(),
  }),
]);

/** Generation parameters shared by complete and delegate. */
const generationShape = {
  prompt: z.string().optional().describe("Plain prompt text (alternative to messages)"),
  system: z.string().optional().describe("System instruction"),
  messages: z
    .array(messageSchema)
    .optional()
    .describe("Chat messages; content may be a string or text/image parts (vision models)"),
  maxTokens: z.number().int().positive().optional().describe("Maximum tokens to generate"),
  temperature: z.number().optional().describe("Sampling temperature"),
  topP: z.number().optional(),
  topK: z.number().int().optional(),
  seed: z.number().int().optional().describe("Seed for reproducible sampling"),
  repeatPenalty: z.number().optional(),
  stop: z.array(z.string()).optional().describe("Stop sequences"),
  contextLength: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Context window to run with (Ollama num_ctx). Raise it for long inputs to avoid truncation."),
  responseFormat: responseFormatSchema
    .optional()
    .describe("Constrain output to JSON (json_object) or a JSON Schema (json_schema); the result includes a validated 'parsed' value"),
  options: z.record(z.string(), z.unknown()).optional().describe("Provider-specific extras passed through as-is"),
  stream: z
    .boolean()
    .optional()
    .describe("Stream tokens (default true). Progress notifications are sent when the client provides a progressToken."),
};

type GenerationArgs = {
  prompt?: string;
  system?: string;
  messages?: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  repeatPenalty?: number;
  stop?: string[];
  contextLength?: number;
  responseFormat?: CompletionParams["responseFormat"];
  options?: Record<string, unknown>;
  stream?: boolean;
};

/**
 * Compiled validators keyed by schema text. Each schema gets its own Ajv
 * instance so a reused `$id` never collides, and the map is bounded so a
 * long-lived server does not grow with every distinct schema.
 */
const validators = new Map<string, ValidateFunction>();
const MAX_VALIDATORS = 64;

function compileSchema(schema: unknown): ValidateFunction {
  const key = JSON.stringify(schema);
  const hit = validators.get(key);
  if (hit) {
    validators.delete(key);
    validators.set(key, hit);
    return hit;
  }
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema as object);
  validators.set(key, validate);
  if (validators.size > MAX_VALIDATORS) validators.delete(validators.keys().next().value as string);
  return validate;
}

/** Validate `parsed` against a requested JSON schema; adds schemaValid/schemaErrors. */
export function validateStructured(result: CompletionResult, format: CompletionParams["responseFormat"]): CompletionResult {
  if (format?.type !== "json_schema" || result.parsed === undefined) return result;
  try {
    const validate = compileSchema(format.schema);
    const valid = validate(result.parsed) as boolean;
    return {
      ...result,
      schemaValid: valid,
      ...(valid ? {} : { schemaErrors: (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`) }),
    } as CompletionResult;
  } catch (err) {
    return { ...result, schemaValid: false, schemaErrors: [`invalid schema: ${String(err)}`] } as CompletionResult;
  }
}

async function runCompletion(
  ctx: ToolContext,
  p: Provider,
  model: string,
  args: GenerationArgs,
  extra: Extra | undefined,
): Promise<CompletionResult> {
  const { config } = ctx;
  const { stream, ...gen } = args;
  const wantStream = stream !== false;
  const send = progressSender(extra);
  let progress = 0;
  const onChunk = wantStream
    ? async (chunk: { text: string; done: boolean }) => {
        if (!chunk.text || !send) return;
        progress += 1;
        await send(progress, undefined, chunk.text);
      }
    : undefined;
  try {
    const result = await p.complete(
      { model, ...gen },
      {
        // Streams rely on the idle timeout; the overall cap is generous.
        ...reqOpts(wantStream ? config.streamMaxMs : config.requestTimeoutMs, extra),
        idleTimeoutMs: config.streamIdleTimeoutMs,
        onChunk,
      },
    );
    return validateStructured(result, gen.responseFormat);
  } catch (err) {
    ctx.manager.invalidate(p.name);
    throw err;
  }
}

function requireInput(args: GenerationArgs): void {
  if (!args.prompt && (!args.messages || args.messages.length === 0)) {
    throw new Error("Provide either 'prompt' or non-empty 'messages'.");
  }
}

export const DELEGATE_TASKS = ["chat", "code", "summarize", "extract", "reasoning", "vision", "general"] as const;
export type DelegateTask = (typeof DELEGATE_TASKS)[number];

/** Map delegate tasks onto catalog task tags (summarize/extract are chat work). */
const TASK_TAG: Record<DelegateTask, CatalogTask> = {
  chat: "chat",
  code: "code",
  summarize: "chat",
  extract: "chat",
  reasoning: "reasoning",
  vision: "vision",
  general: "general",
};

/** Tasks a general chat model can stand in for when no specialist is present. */
const GENERAL_OK = new Set<DelegateTask>(["chat", "summarize", "extract", "general", "reasoning", "code"]);

export interface Candidate {
  provider: Provider;
  model: string;
  tier: "loaded" | "installed" | "pull";
  specialist: boolean;
  sizeBytes?: number;
  /** Parameter count in billions, when the runtime or catalog reports it. */
  parameterBillions?: number;
  fitTarget?: string;
  /** Fresh benchmark of this model on this machine, if any. */
  speed?: SpeedRecord;
}

/** Models whose scale is within this factor of a size tier's largest model share the tier. */
export const SIZE_TIER_RATIO = 1.2;
/** ~4.5 bits per weight (Q4_K_M): estimates scale from file size when the parameter count is unknown. */
const BYTES_PER_PARAM_ESTIMATE = 0.5625;

/** Model scale in billions of parameters: reported, else estimated from weight size, else 0. */
export function modelScale(c: Pick<Candidate, "parameterBillions" | "sizeBytes">): number {
  if (c.parameterBillions) return c.parameterBillions;
  if (c.sizeBytes) return c.sizeBytes / BYTES_PER_PARAM_ESTIMATE / 1e9;
  return 0;
}

/**
 * Assign size tiers: walk from the largest model down; a tier holds every
 * model within SIZE_TIER_RATIO of the tier's largest. Returns tier indexes
 * (0 = largest) keyed by candidate.
 */
export function sizeTiers(cands: Candidate[]): Map<Candidate, number> {
  const tiers = new Map<Candidate, number>();
  const bySize = [...cands].sort((a, b) => modelScale(b) - modelScale(a));
  let tier = -1;
  let head = Number.POSITIVE_INFINITY;
  for (const c of bySize) {
    const s = modelScale(c);
    if (tier < 0 || s * SIZE_TIER_RATIO < head) {
      tier += 1;
      head = s;
    }
    tiers.set(c, tier);
  }
  return tiers;
}

const READINESS = { loaded: 0, installed: 1, pull: 2 } as const;

/**
 * Score candidates: a task specialist beats a general model; loaded beats
 * installed beats pull (no load cost). Within that, a higher size tier
 * (models within ~20% of each other share one) wins. Fresh benchmarked speed
 * on this machine only breaks ties inside a size tier, so a small measured
 * model never outranks an unmeasured model from a higher tier. Remaining
 * ties go to the larger model.
 */
export function rankCandidates(cands: Candidate[]): Candidate[] {
  const group = (c: Candidate) => `${c.specialist ? 0 : 1}:${READINESS[c.tier]}`;
  const tierOf = new Map<Candidate, number>();
  const groups = new Map<string, Candidate[]>();
  for (const c of cands) groups.set(group(c), [...(groups.get(group(c)) ?? []), c]);
  for (const members of groups.values()) for (const [c, t] of sizeTiers(members)) tierOf.set(c, t);

  return [...cands].sort((a, b) => {
    if (a.specialist !== b.specialist) return a.specialist ? -1 : 1;
    if (READINESS[a.tier] !== READINESS[b.tier]) return READINESS[a.tier] - READINESS[b.tier];
    const ta = tierOf.get(a) ?? 0;
    const tb = tierOf.get(b) ?? 0;
    if (ta !== tb) return ta - tb;
    if (!!a.speed !== !!b.speed) return a.speed ? -1 : 1;
    if (a.speed && b.speed && a.speed.genTokensPerSec !== b.speed.genTokensPerSec) {
      return b.speed.genTokensPerSec - a.speed.genTokensPerSec;
    }
    return modelScale(b) - modelScale(a);
  });
}

/** The ranking reason for the routing explanation. */
export function rankingReason(chosen: Candidate, ranked: Candidate[]): string {
  const group = ranked.filter((c) => c.specialist === chosen.specialist && c.tier === chosen.tier);
  const tiers = sizeTiers(group.includes(chosen) ? group : [...group, chosen]);
  const peers = group.filter((c) => c !== chosen && tiers.get(c) === tiers.get(chosen));
  if (chosen.speed && peers.length > 0) {
    const s = chosen.speed;
    const est = s.estimated ? ", estimated" : "";
    return `size tier tie broken by measured speed: ${s.genTokensPerSec} tok/s on this machine (benchmark ${s.measuredAt.slice(0, 10)}${est})`;
  }
  if (peers.length > 0) {
    return "size tier tie broken by size: no fresh benchmark on this machine for the models in this tier";
  }
  return "largest size tier among equally suited and ready models";
}

export function register(server: McpServer, ctx: ToolContext): void {
  const { manager, config, hardware } = ctx;

  server.registerTool(
    "complete",
    {
      title: "Delegated completion",
      description:
        "DELEGATED INFERENCE: Offload a completion to a model you choose for cost savings and privacy. Without provider, runs on the live LOCAL provider that has the model (never a hosted API unless LOCAL_AI_ALLOW_HOSTED_FALLBACK is set); the result's 'provider', 'host' and 'local' fields say where it ran. Supports system prompts, JSON / JSON-Schema output (validated 'parsed' field), seed/topP/topK, image inputs for vision models, and contextLength for long inputs. Streams tokens via MCP progress notifications when the client sends a progressToken.",
      inputSchema: {
        model: z.string().describe("Model id/name to run the completion on"),
        ...generationShape,
        provider: providerArg(ctx).optional(),
      },
      outputSchema: {
        provider: z.string(),
        host: z.string(),
        local: z.boolean(),
        model: z.string(),
        text: z.string(),
        parsed: z.unknown().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ model, provider, ...gen }, extra) => {
      requireInput(gen as GenerationArgs);
      const p = await manager.select(provider, model, reqOpts(config.detectTimeoutMs, extra), { capability: "complete" });
      const result = await runCompletion(ctx, p, model, gen as GenerationArgs, extra);
      return ok({ ...result });
    }),
  );

  server.registerTool(
    "embed",
    {
      title: "Delegated embeddings",
      description:
        "DELEGATED EMBEDDINGS: Generate embeddings for a string or an array of texts. Without provider, runs on the live local provider that has the model. Always returns one vector per input.",
      inputSchema: {
        model: z.string().describe("Embedding model id/name"),
        input: z.union([z.string(), z.array(z.string())]).describe("Text or array of texts to embed"),
        provider: providerArg(ctx).optional(),
      },
      outputSchema: {
        provider: z.string(),
        host: z.string(),
        local: z.boolean(),
        model: z.string(),
        embeddings: z.array(z.array(z.number())),
        dimensions: z.number(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ model, input, provider }, extra) => {
      const p = await manager.select(provider, model, reqOpts(config.detectTimeoutMs, extra), { capability: "embed" });
      const result = await p.embed({ model, input }, reqOpts(config.requestTimeoutMs, extra));
      return ok({ ...result });
    }),
  );

  server.registerTool(
    "delegate",
    {
      title: "Delegate a task to the best local model",
      description:
        "ONE CALL to offload work locally: pick the best model for a task on THIS machine, make it ready, and run it. Prefers models already loaded (no load cost), then installed models that fit your free VRAM, then (with allowPull) the best catalog model that fits. Task specialists (coder, vision, reasoning) win over general models; then larger fitting models win, grouped into size tiers (within ~20% parameter count); inside a tier, the model benchmarked fastest on this machine wins (run benchmark to record speeds; results expire after 14 days). Never uses a hosted provider unless allowHosted is true. Returns the completion plus a 'routing' block explaining the choice.",
      inputSchema: {
        task: z.enum(DELEGATE_TASKS).describe("What kind of work this is"),
        ...generationShape,
        allowPull: z.boolean().optional().describe("Download a catalog model if nothing suitable is installed (default false)"),
        allowHosted: z.boolean().optional().describe("Allow hosted providers (default false)"),
        maxSizeBytes: z.number().positive().optional().describe("Ignore models larger than this"),
        provider: providerArg(ctx, "Restrict to one provider").optional(),
      },
      outputSchema: {
        routing: anyRecord,
        provider: z.string(),
        model: z.string(),
        text: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ task, allowPull, allowHosted, maxSizeBytes, provider, ...gen }, extra) => {
      requireInput(gen as GenerationArgs);
      const detectOpts = reqOpts(config.detectTimeoutMs, extra);
      const opts = reqOpts(config.requestTimeoutMs, extra);
      const tag = TASK_TAG[task];
      const hostedOk = allowHosted || config.allowHostedFallback;
      let pool = (await manager.detected(detectOpts)).filter(
        (p) => p.capabilities().complete && (p.kind === "local" || hostedOk),
      );
      if (provider) pool = pool.filter((p) => p.name === provider);
      const resources = await hardware.getSystemResources();
      const contextLength = gen.contextLength;
      const speedOf = ctx.speeds.lookup(machineFingerprint(resources));

      const cands: Candidate[] = [];
      await Promise.all(
        pool.map(async (p) => {
          const [models, loaded] = await Promise.all([
            manager.listModelsCached(p, opts).catch(() => [] as ModelSummary[]),
            p.listLoaded(opts).catch(() => [] as LoadedModelInfo[]),
          ]);
          const loadedIds = new Set(loaded.map((m) => m.id));
          const seen = new Set<string>();
          for (const m of [...loaded.map((l) => ({ id: l.id, sizeBytes: l.sizeBytes })), ...models]) {
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            const listed = models.find((x) => x.id === m.id);
            const tasks = tasksForModel(m.id, listed?.family);
            if (tasks.includes("embed")) continue;
            const specialist = tasks.includes(tag) && tag !== "chat" && tag !== "general";
            const usable = tasks.includes(tag) || GENERAL_OK.has(task);
            if (!usable || (task === "vision" && !tasks.includes("vision"))) continue;
            const sizeBytes = listed?.sizeBytes ?? (m as { sizeBytes?: number }).sizeBytes ?? findCatalog(m.id)?.approxSizeBytes;
            if (maxSizeBytes && sizeBytes && sizeBytes > maxSizeBytes) continue;
            const isLoaded = loadedIds.has(m.id);
            let fitTarget: string | undefined;
            if (!isLoaded && sizeBytes && p.kind === "local") {
              const fit = computeFit(resources, sizeBytes, {
                contextLength,
                parameterSize: listed?.parameterSize ?? findCatalog(m.id)?.parameterSize,
              });
              fitTarget = fit.target;
              if (fit.target === "none" || fit.target === "cpu") continue;
            }
            cands.push({
              provider: p,
              model: m.id,
              tier: isLoaded ? "loaded" : "installed",
              specialist,
              sizeBytes,
              parameterBillions: parseParameterBillions(listed?.parameterSize ?? findCatalog(m.id)?.parameterSize),
              fitTarget,
              speed:
                p.kind === "local"
                  ? speedOf(p.host, m.id, { quantization: listed?.quantization, sizeBytes: listed?.sizeBytes })
                  : undefined,
            });
          }
        }),
      );

      let ranked = rankCandidates(cands);
      let pulled = false;
      if (ranked.length === 0 && allowPull) {
        const puller = pool.find((p) => p.type === "ollama" && p.capabilities().pull);
        const pick = puller
          ? rankSuggestions(resources, tag, { contextLength }).find((s) => s.target === "gpu" || s.target === "partial")
          : undefined;
        if (puller && pick) {
          await ensureModel(ctx, { model: pick.name, provider: puller.name, allowPull: true, contextLength }, extra);
          pulled = true;
          ranked = [{ provider: puller, model: pick.name, tier: "pull", specialist: pick.tasks.includes(tag), sizeBytes: pick.approxSizeBytes, fitTarget: pick.target }];
        }
      }
      const chosen = ranked[0];
      if (!chosen) {
        throw new Error(
          `No suitable local model for task "${task}" on ${pool.map((p) => p.name).join(", ") || "any live provider"}. ` +
            `Install one (see suggest_model), or pass allowPull:true.`,
        );
      }
      const why = [
        chosen.tier === "loaded" ? "already loaded (no load cost)" : chosen.tier === "pull" ? "downloaded: nothing suitable was installed" : "installed",
        chosen.specialist ? `${tag} specialist` : "general model",
        chosen.fitTarget ? `fits: ${chosen.fitTarget}` : undefined,
        rankingReason(chosen, ranked),
      ]
        .filter(Boolean)
        .join("; ");
      const result = await runCompletion(ctx, chosen.provider, chosen.model, gen as GenerationArgs, extra);
      return ok({
        ...result,
        routing: {
          task,
          provider: chosen.provider.name,
          model: chosen.model,
          tier: chosen.tier,
          why,
          pulled,
          considered: ranked.slice(0, 5).map((c) => ({ provider: c.provider.name, model: c.model, tier: c.tier, specialist: c.specialist })),
        },
      });
    }),
  );
}
