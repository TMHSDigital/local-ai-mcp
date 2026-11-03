import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../server.js";
import { MAX_FINISHED_PULL_JOBS, PULL_JOB_RETENTION_MS, PullJobs } from "../tools/jobs.js";
import { FakeProvider, fakeHardware, testConfig } from "./support.js";

async function connect(p: FakeProvider) {
  const { server, ctx } = createServer(testConfig(), { providers: [p], hardware: fakeHardware() });
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(JSON.parse((res.content as Array<{ text: string }>)[0].text).error);
    return res.structuredContent as Record<string, any>;
  };
  return { ctx, call };
}

describe("background pulls", () => {
  it("returns a job at once, then reports progress and the result", async () => {
    const p = new FakeProvider("ollama");
    const { ctx, call } = await connect(p);
    const { job } = await call("pull_model", { model: "qwen3:8b", background: true });
    expect(job).toMatchObject({ provider: "ollama", model: "qwen3:8b", state: "running" });
    await ctx.pullJobs.settled(job.jobId);
    const { jobs } = await call("pull_status", { jobId: job.jobId });
    expect(jobs[0]).toMatchObject({
      state: "done",
      result: { status: "success" },
      progress: { status: "success", completed: 100, total: 100, percent: 100 },
    });
    expect(p.models.map((m) => m.id)).toContain("qwen3:8b");
  });

  it("joins a running job for the same model and can cancel it", async () => {
    const p = new FakeProvider("ollama");
    p.pull = ((model: string, opts: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error(`aborted ${model}`)));
      })) as FakeProvider["pull"];
    const { ctx, call } = await connect(p);
    const first = (await call("pull_model", { model: "big:70b", background: true })).job;
    const second = (await call("pull_model", { model: "big:70b", background: true })).job;
    expect(second.jobId).toBe(first.jobId);

    await call("pull_cancel", { jobId: first.jobId });
    await ctx.pullJobs.settled(first.jobId);
    const { jobs } = await call("pull_status", {});
    expect(jobs).toEqual([expect.objectContaining({ jobId: first.jobId, state: "cancelled" })]);
  });

  it("reports failures and rejects unknown job ids", async () => {
    const p = new FakeProvider("ollama");
    p.pull = async () => {
      throw new Error("manifest unknown");
    };
    const { ctx, call } = await connect(p);
    const { job } = await call("pull_model", { model: "nope:1b", background: true });
    await ctx.pullJobs.settled(job.jobId);
    expect((await call("pull_status", { jobId: job.jobId })).jobs[0]).toMatchObject({ state: "failed", error: "manifest unknown" });
    await expect(call("pull_status", { jobId: "missing" })).rejects.toThrow(/Unknown pull job/);
    await expect(call("pull_cancel", { jobId: "missing" })).rejects.toThrow(/Unknown pull job/);
  });
});

describe("PullJobs retention", () => {
  it("forgets finished jobs after the retention window and caps how many are kept", async () => {
    let now = 0;
    const jobs = new PullJobs(() => now);
    const p = new FakeProvider("ollama");
    const ids: string[] = [];
    for (let i = 0; i < MAX_FINISHED_PULL_JOBS + 5; i++) {
      const j = jobs.start(p, `m${i}`, async () => ({ provider: "ollama", model: `m${i}`, status: "success" }));
      await jobs.settled(j.jobId);
      ids.push(j.jobId);
    }
    expect(jobs.list()).toHaveLength(MAX_FINISHED_PULL_JOBS);
    expect(jobs.get(ids[0])).toBeUndefined();
    now = PULL_JOB_RETENTION_MS + 1;
    expect(jobs.list()).toHaveLength(0);
  });
});
