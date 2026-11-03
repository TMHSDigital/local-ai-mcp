import { randomUUID } from "node:crypto";
import type { Provider, PullProgress, PullResult } from "../providers/types.js";

export type PullJobState = "running" | "done" | "failed" | "cancelled";

export interface PullJob {
  jobId: string;
  provider: string;
  model: string;
  state: PullJobState;
  startedAt: string;
  finishedAt?: string;
  progress?: PullProgress & { percent?: number };
  result?: PullResult;
  error?: string;
}

/** Finished jobs are kept this long so callers can read the outcome. */
export const PULL_JOB_RETENTION_MS = 60 * 60 * 1000;
/** At most this many finished jobs are kept; the oldest are dropped first. */
export const MAX_FINISHED_PULL_JOBS = 50;

interface Entry {
  job: PullJob;
  controller: AbortController;
  done: Promise<void>;
}

/**
 * In-memory background pulls. Jobs live only as long as the server process:
 * a restart forgets them (the runtime may still finish the download).
 */
export class PullJobs {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Start a pull in the background, or return the job already pulling the
   * same model on the same provider.
   */
  start(
    p: Provider,
    model: string,
    run: (signal: AbortSignal, onProgress: (prog: PullProgress) => void) => Promise<PullResult>,
    onFinish?: () => void,
  ): PullJob {
    this.prune();
    for (const e of this.entries.values()) {
      if (e.job.state === "running" && e.job.provider === p.name && e.job.model === model) return { ...e.job };
    }
    const controller = new AbortController();
    const job: PullJob = {
      jobId: randomUUID(),
      provider: p.name,
      model,
      state: "running",
      startedAt: new Date(this.now()).toISOString(),
    };
    const finish = (state: PullJobState, extra: Partial<PullJob>) => {
      if (job.state !== "running") return;
      Object.assign(job, { state, finishedAt: new Date(this.now()).toISOString() }, extra);
      onFinish?.();
    };
    const done = run(controller.signal, (prog) => {
      const percent =
        prog.completed !== undefined && prog.total ? Math.round((prog.completed / prog.total) * 1000) / 10 : undefined;
      job.progress = { ...prog, ...(percent !== undefined ? { percent } : {}) };
    }).then(
      (result) => finish("done", { result }),
      (err: unknown) =>
        finish(controller.signal.aborted ? "cancelled" : "failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
    );
    this.entries.set(job.jobId, { job, controller, done });
    return { ...job };
  }

  get(jobId: string): PullJob | undefined {
    this.prune();
    const e = this.entries.get(jobId);
    return e ? { ...e.job } : undefined;
  }

  list(): PullJob[] {
    this.prune();
    return [...this.entries.values()].map((e) => ({ ...e.job }));
  }

  /** Abort a running job. Returns the job, or undefined if unknown. */
  cancel(jobId: string): PullJob | undefined {
    const e = this.entries.get(jobId);
    if (!e) return undefined;
    if (e.job.state === "running") e.controller.abort(new Error("pull cancelled"));
    return { ...e.job };
  }

  /** Resolves when the job has settled. For tests and graceful shutdown. */
  async settled(jobId: string): Promise<void> {
    await this.entries.get(jobId)?.done;
  }

  private prune(): void {
    const cutoff = this.now() - PULL_JOB_RETENTION_MS;
    const finished = [...this.entries.values()].filter((e) => e.job.state !== "running");
    for (const e of finished) {
      if (e.job.finishedAt && Date.parse(e.job.finishedAt) < cutoff) this.entries.delete(e.job.jobId);
    }
    const left = finished.filter((e) => this.entries.has(e.job.jobId));
    for (const e of left.slice(0, Math.max(0, left.length - MAX_FINISHED_PULL_JOBS))) this.entries.delete(e.job.jobId);
  }
}
