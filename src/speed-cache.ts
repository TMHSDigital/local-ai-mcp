import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import type { SystemResources } from "./hardware/index.js";
import { sameModel } from "./model-id.js";

/** Benchmarks older than this are ignored: runtimes, drivers and models change. */
export const SPEED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Keep the file small; the oldest records are dropped first. */
const MAX_RECORDS = 500;

/** One measured model on one machine, as written by the benchmark tool. */
export interface SpeedRecord {
  /** machineFingerprint() of the machine that ran the benchmark. */
  machine: string;
  /** Provider host: identifies the runtime instance across renames. */
  host: string;
  provider: string;
  model: string;
  /** Median generation speed. */
  genTokensPerSec: number;
  ttftMs?: number;
  contextLength?: number;
  quantization?: string;
  sizeBytes?: number;
  /** True when the speed was timed client-side rather than reported by the runtime. */
  estimated: boolean;
  /** ISO timestamp. */
  measuredAt: string;
}

/** What the runtime currently reports for the model, used to spot re-pulls. */
export interface CurrentModel {
  quantization?: string;
  sizeBytes?: number;
}

/** Per-user cache location, outside any project: LOCALAPPDATA / Library/Caches / XDG_CACHE_HOME. */
export function defaultSpeedCachePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = os.platform(),
  home: string = os.homedir(),
): string {
  const base =
    platform === "win32"
      ? env.LOCALAPPDATA || join(home, "AppData", "Local")
      : platform === "darwin"
        ? join(home, "Library", "Caches")
        : env.XDG_CACHE_HOME || join(home, ".cache");
  return join(base, "local-ai-mcp", "benchmarks.json");
}

/**
 * Stable id for "this machine as benchmarked": host name plus the hardware
 * that decides speed. A GPU swap or RAM change starts a fresh set of records,
 * and a home directory synced between machines never mixes them up.
 */
export function machineFingerprint(r: SystemResources, hostname: string = os.hostname()): string {
  const gpus = r.gpus.map((g) => `${g.name}:${g.vramTotalBytes ?? "?"}`).sort();
  const ramGb = Math.round(r.ramTotalBytes / 1024 ** 3);
  const key = JSON.stringify([hostname.toLowerCase(), r.platform, r.cpuCount, ramGb, gpus]);
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** Why a record can't be trusted any more, or undefined if it is fresh. */
export function staleReason(rec: SpeedRecord, current: CurrentModel, now: number): string | undefined {
  const age = now - Date.parse(rec.measuredAt);
  if (!Number.isFinite(age) || age > SPEED_MAX_AGE_MS) return "older than 14 days";
  if (current.quantization && rec.quantization && current.quantization !== rec.quantization) {
    return `quantization changed (${rec.quantization} -> ${current.quantization})`;
  }
  if (current.sizeBytes && rec.sizeBytes && current.sizeBytes !== rec.sizeBytes) return "model file changed";
  return undefined;
}

function isRecord(x: unknown): x is SpeedRecord {
  const r = x as SpeedRecord;
  return (
    !!r &&
    typeof r.machine === "string" &&
    typeof r.host === "string" &&
    typeof r.model === "string" &&
    typeof r.genTokensPerSec === "number" &&
    Number.isFinite(r.genTokensPerSec) &&
    typeof r.measuredAt === "string"
  );
}

/**
 * Small JSON file of benchmark results. A missing or corrupt file reads as
 * empty; writes are atomic (temp file + rename). A path of undefined disables
 * the cache entirely.
 */
export class SpeedCache {
  constructor(
    readonly path: string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.path !== undefined;
  }

  all(): SpeedRecord[] {
    if (!this.path) return [];
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as { records?: unknown };
      return Array.isArray(data.records) ? data.records.filter(isRecord) : [];
    } catch {
      return [];
    }
  }

  /** Store a result, replacing any earlier one for the same machine, host and model. */
  record(rec: Omit<SpeedRecord, "measuredAt">): SpeedRecord | undefined {
    if (!this.path) return undefined;
    const entry: SpeedRecord = { ...rec, measuredAt: new Date(this.now()).toISOString() };
    const kept = this.all().filter((r) => !(r.machine === rec.machine && r.host === rec.host && sameModel(r.model, rec.model)));
    kept.push(entry);
    kept.sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt));
    const records = kept.slice(-MAX_RECORDS);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ version: 1, records }, null, 2)}\n`);
      renameSync(tmp, this.path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return entry;
  }

  /**
   * Fresh-record lookup for one machine. Reads the file once; call the
   * returned function per candidate.
   */
  lookup(machine: string): (host: string, model: string, current?: CurrentModel) => SpeedRecord | undefined {
    const now = this.now();
    const mine = this.all().filter((r) => r.machine === machine);
    return (host, model, current = {}) => {
      const rec = mine.find((r) => r.host === host && sameModel(r.model, model));
      return rec && !staleReason(rec, current, now) ? rec : undefined;
    };
  }
}
