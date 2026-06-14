import { afterEach, describe, expect, it, vi } from "vitest";
import { httpText } from "../http.js";

const URL = "http://localhost:11434/api/pull";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("httpText timeout handling", () => {
  it("attaches an abort signal when timeoutMs > 0", async () => {
    let captured: AbortSignal | null | undefined;
    const fn = vi.fn(async (_url: string, init?: RequestInit) => {
      captured = init?.signal;
      return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
    });
    vi.stubGlobal("fetch", fn);

    await httpText(URL, { timeoutMs: 5000 });
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured?.aborted).toBe(false);
  });

  it("does NOT attach a signal when timeoutMs <= 0 (timeout disabled)", async () => {
    let captured: AbortSignal | null | undefined = "untouched" as unknown as AbortSignal;
    const fn = vi.fn(async (_url: string, init?: RequestInit) => {
      captured = init?.signal;
      return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
    });
    vi.stubGlobal("fetch", fn);

    await httpText(URL, { timeoutMs: 0 });
    // No AbortController created => signal is undefined (not attached).
    expect(captured).toBeUndefined();
  });

  it("a slow fetch still resolves when the timeout is disabled", async () => {
    const fn = vi.fn(async (_url: string, init?: RequestInit) => {
      // Simulate a slow response longer than any reasonable timeout would allow.
      await new Promise((resolve) => setTimeout(resolve, 50));
      // If a timeout had been applied with a tiny value it would have aborted;
      // here it must not.
      expect(init?.signal).toBeUndefined();
      return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
    });
    vi.stubGlobal("fetch", fn);

    const text = await httpText(URL, { timeoutMs: -1 });
    expect(text).toBe("{}");
  });
});
