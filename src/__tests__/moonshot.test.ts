import { afterEach, describe, expect, it, vi } from "vitest";
import { MoonshotProvider } from "../providers/moonshot.js";
import { mockFetch } from "./support.js";

const HOST = "https://api.moonshot.ai/v1";
const FAKE_KEY = "test-key-not-real";
const OPTS = { timeoutMs: 5000 };

afterEach(() => vi.unstubAllGlobals());

describe("MoonshotProvider", () => {
  it("is always hosted and complete-only", () => {
    const p = new MoonshotProvider(HOST, { apiKey: FAKE_KEY });
    expect(p.kind).toBe("hosted");
    expect(p.capabilities()).toMatchObject({ kind: "hosted", complete: true, embed: false, pull: false, load: false });
  });

  it("detects from configuration without a network call", async () => {
    const calls = mockFetch(() => ({ body: {} }));
    expect(await new MoonshotProvider(HOST, { apiKey: FAKE_KEY }).detect(OPTS)).toBe(true);
    expect(await new MoonshotProvider(HOST).detect(OPTS)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("sends Bearer auth and marks results non-local", async () => {
    const calls = mockFetch(() => ({ body: { choices: [{ message: { content: "hi" } }] } }));
    const r = await new MoonshotProvider(HOST, { apiKey: FAKE_KEY }).complete({ model: "kimi-k3", prompt: "x" }, OPTS);
    expect(calls[0].url).toBe(`${HOST}/chat/completions`);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(r).toMatchObject({ provider: "moonshot", local: false, text: "hi" });
  });

  it("health makes the real check and reports auth failures", async () => {
    mockFetch(() => ({ status: 401, text: "invalid key" }));
    const h = await new MoonshotProvider(HOST, { apiKey: FAKE_KEY }).health(OPTS);
    expect(h).toMatchObject({ live: false, kind: "hosted" });
    expect(h.error).toMatch(/401/);
  });

  it("fails clearly without a key and for unsupported ops", async () => {
    await expect(new MoonshotProvider(HOST).listModels(OPTS)).rejects.toThrow(/MOONSHOT_API_KEY is not set/);
    const p = new MoonshotProvider(HOST, { apiKey: FAKE_KEY });
    await expect(p.embed({ model: "x", input: "y" }, OPTS)).rejects.toThrow(/does not support embed/);
    await expect(p.pull("x", OPTS)).rejects.toThrow(/does not support pull/);
    expect(await p.listLoaded(OPTS)).toEqual([]);
  });
});
