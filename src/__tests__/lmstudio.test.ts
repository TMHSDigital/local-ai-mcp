import { afterEach, describe, expect, it, vi } from "vitest";
import { LMStudioProvider, type CliResult } from "../providers/lmstudio.js";

const HOST = "http://localhost:1234";
const TIMEOUT = 5000;

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

function mockFetch(handler: (url: string) => { status?: number; body: unknown }) {
  const calls: Recorded[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const { status = 200, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

function cliRunnerFor(record: string[][], available = true): (args: string[]) => CliResult {
  return (args: string[]) => {
    record.push(args);
    if (args[0] === "version") {
      return { status: available ? 0 : 1, stdout: available ? "1.0.0" : "", stderr: "" };
    }
    return { status: 0, stdout: "ok", stderr: "" };
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LMStudioProvider", () => {
  it("listModels maps /api/v0/models", async () => {
    const calls = mockFetch(() => ({
      body: {
        data: [
          { id: "qwen2.5-coder", type: "llm", arch: "qwen2", quantization: "Q4_K_M", state: "not-loaded" },
        ],
      },
    }));
    const p = new LMStudioProvider(HOST, cliRunnerFor([], false));
    const models = await p.listModels(TIMEOUT);
    expect(calls[0].url).toBe(`${HOST}/api/v0/models`);
    expect(models[0]).toMatchObject({ id: "qwen2.5-coder", provider: "lmstudio", family: "qwen2" });
  });

  it("listLoaded filters to state=loaded", async () => {
    mockFetch(() => ({
      body: {
        data: [
          { id: "a", state: "loaded", loaded_context_length: 4096 },
          { id: "b", state: "not-loaded" },
        ],
      },
    }));
    const p = new LMStudioProvider(HOST, cliRunnerFor([], false));
    const loaded = await p.listLoaded(TIMEOUT);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual({ id: "a", provider: "lmstudio", contextLength: 4096 });
  });

  it("complete posts /v1/chat/completions", async () => {
    const calls = mockFetch(() => ({
      body: { choices: [{ message: { content: "hi" } }], usage: { completion_tokens: 1 } },
    }));
    const p = new LMStudioProvider(HOST, cliRunnerFor([], false));
    const res = await p.complete({ model: "m", prompt: "x" }, TIMEOUT);
    expect(calls[0].url).toBe(`${HOST}/v1/chat/completions`);
    expect(res.text).toBe("hi");
  });

  it("embed posts /v1/embeddings", async () => {
    const calls = mockFetch(() => ({ body: { data: [{ embedding: [1, 2] }] } }));
    const p = new LMStudioProvider(HOST, cliRunnerFor([], false));
    const res = await p.embed({ model: "m", input: "x" }, TIMEOUT);
    expect(calls[0].url).toBe(`${HOST}/v1/embeddings`);
    expect(res.dimensions).toBe(2);
  });

  it("load/unload call the lms CLI when available", async () => {
    mockFetch(() => ({ body: {} }));
    const record: string[][] = [];
    const p = new LMStudioProvider(HOST, cliRunnerFor(record, true));
    const loaded = await p.load("m", TIMEOUT);
    const unloaded = await p.unload("m", TIMEOUT);
    expect(loaded.loaded).toBe(true);
    expect(unloaded.unloaded).toBe(true);
    expect(record).toContainEqual(["load", "m"]);
    expect(record).toContainEqual(["unload", "m"]);
  });

  it("load returns JIT note when CLI absent", async () => {
    const p = new LMStudioProvider(HOST, cliRunnerFor([], false));
    const loaded = await p.load("m", TIMEOUT);
    expect(loaded.loaded).toBe(true);
    expect(loaded.detail).toContain("JIT");
  });

  it("unload throws when CLI absent", async () => {
    const p = new LMStudioProvider(HOST, cliRunnerFor([], false));
    await expect(p.unload("m", TIMEOUT)).rejects.toThrow(/lms CLI/);
  });

  it("capabilities reflect lms availability", () => {
    const withCli = new LMStudioProvider(HOST, cliRunnerFor([], true));
    const noCli = new LMStudioProvider(HOST, cliRunnerFor([], false));
    expect(withCli.capabilities().pull).toBe(true);
    expect(noCli.capabilities().pull).toBe(false);
    expect(noCli.capabilities().complete).toBe(true);
  });
});
