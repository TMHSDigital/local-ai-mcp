import { afterEach, describe, expect, it, vi } from "vitest";
import { keepAliveToSeconds, LMStudioProvider, type CliRunner } from "../providers/lmstudio.js";
import { mockFetch } from "./support.js";

const HOST = "http://localhost:1234";
const OPTS = { timeoutMs: 5000 };

afterEach(() => vi.unstubAllGlobals());

function cli(available: boolean, record: string[][] = [], output = ""): CliRunner {
  return async (args, opts) => {
    record.push(args);
    if (args[0] === "version") return { status: available ? 0 : 1, stdout: "", stderr: "" };
    if (output) opts.onOutput?.(output);
    return { status: 0, stdout: "ok", stderr: "" };
  };
}

describe("LMStudioProvider", () => {
  it("lists models and loaded models from /api/v0", async () => {
    mockFetch(() => ({
      body: {
        data: [
          { id: "qwen2.5-7b", arch: "qwen2", quantization: "Q4_K_M", state: "loaded", max_context_length: 32768, loaded_context_length: 8192 },
          { id: "phi-4", state: "not-loaded" },
        ],
      },
    }));
    const p = new LMStudioProvider(HOST, { cliRunner: cli(false) });
    expect(await p.listModels(OPTS)).toEqual([
      { id: "qwen2.5-7b", provider: "lmstudio", family: "qwen2", quantization: "Q4_K_M", contextLength: 32768 },
      { id: "phi-4", provider: "lmstudio" },
    ]);
    expect(await p.listLoaded(OPTS)).toEqual([{ id: "qwen2.5-7b", provider: "lmstudio", contextLength: 8192 }]);
  });

  it("reports lifecycle capabilities once detect has checked for the CLI", async () => {
    mockFetch(() => ({ body: { data: [] } }));
    const withCli = new LMStudioProvider(HOST, { cliRunner: cli(true) });
    expect(withCli.capabilities().pull).toBe(false);
    expect(await withCli.detect(OPTS)).toBe(true);
    expect(withCli.capabilities()).toMatchObject({ pull: true, load: true, unload: true, remove: true });
    const noCli = new LMStudioProvider(HOST, { cliRunner: cli(false) });
    await noCli.detect(OPTS);
    expect(noCli.capabilities()).toMatchObject({ pull: false, load: false });
  });

  it("pulls non-interactively and parses percentage progress", async () => {
    const record: string[][] = [];
    const progress: unknown[] = [];
    const p = new LMStudioProvider(HOST, { cliRunner: cli(true, record, "Downloading 12.5%\r Downloading 50%") });
    await p.pull("qwen/qwen3-8b", { ...OPTS, onProgress: (x) => void progress.push(x) });
    expect(record.at(-1)).toEqual(["get", "qwen/qwen3-8b", "--yes"]);
    expect(progress).toEqual([{ status: "downloading", completed: 50, total: 100 }]);
  });

  it("loads with ttl and context length; JIT without CLI", async () => {
    const record: string[][] = [];
    await new LMStudioProvider(HOST, { cliRunner: cli(true, record) }).load("m", {
      ...OPTS,
      keepAlive: "5m",
      contextLength: 8192,
    });
    expect(record.at(-1)).toEqual(["load", "m", "--yes", "--ttl", "300", "--context-length", "8192"]);
    const jit = await new LMStudioProvider(HOST, { cliRunner: cli(false) }).load("m", OPTS);
    expect(jit.detail).toMatch(/JIT/);
  });

  it("rejects model ids that could be parsed as CLI flags", async () => {
    const p = new LMStudioProvider(HOST, { cliRunner: cli(true) });
    await expect(p.unload("--all", OPTS)).rejects.toThrow(/Invalid model id/);
    await expect(p.pull("-y", OPTS)).rejects.toThrow(/Invalid model id/);
  });

  it("surfaces CLI failures and missing CLI", async () => {
    const failing: CliRunner = async (args) =>
      args[0] === "version" ? { status: 0, stdout: "", stderr: "" } : { status: 1, stdout: "", stderr: "boom" };
    await expect(new LMStudioProvider(HOST, { cliRunner: failing }).unload("m", OPTS)).rejects.toThrow(/lms unload failed: boom/);
    await expect(new LMStudioProvider(HOST, { cliRunner: cli(false) }).unload("m", OPTS)).rejects.toThrow(/requires the lms CLI/);
  });

  it("completes through /v1/chat/completions", async () => {
    const calls = mockFetch(() => ({ body: { choices: [{ message: { content: "hi" } }] } }));
    const r = await new LMStudioProvider(HOST, { cliRunner: cli(false) }).complete({ model: "m", prompt: "x" }, OPTS);
    expect(calls[0].url).toBe(`${HOST}/v1/chat/completions`);
    expect(r.text).toBe("hi");
  });
});

describe("keepAliveToSeconds", () => {
  it.each([
    ["5m", 300],
    ["1h", 3600],
    ["30s", 30],
    ["90", 90],
    ["bogus", undefined],
  ])("%s", (v, s) => expect(keepAliveToSeconds(v)).toBe(s));
});
