import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, httpJson, httpNdjson, httpSse, probe } from "../http.js";
import { mockFetch } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("httpJson", () => {
  it("sets JSON headers and parses the body", async () => {
    const calls = mockFetch(() => ({ body: { a: 1 } }));
    expect(await httpJson("http://x/y", { method: "POST", body: "{}" })).toEqual({ a: 1 });
    expect(calls[0].headers).toMatchObject({ Accept: "application/json", "Content-Type": "application/json" });
  });

  it("returns {} for an empty body and throws HttpError on non-2xx", async () => {
    mockFetch((url) => (url.endsWith("/empty") ? { text: "" } : { status: 404, text: "nope" }));
    expect(await httpJson("http://x/empty")).toEqual({});
    const err = (await httpJson("http://x/missing").catch((e: unknown) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
    expect(err.body).toBe("nope");
  });

  it("aborts when the caller's signal fires", async () => {
    mockFetch(async (_url, init) => {
      await new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        setTimeout(resolve, 5000);
      });
      return { body: {} };
    });
    const ac = new AbortController();
    const p = httpJson("http://x/slow", { signal: ac.signal, timeoutMs: 0 });
    ac.abort();
    await expect(p).rejects.toThrow(/cancelled/);
  });

  it("aborts on the overall timeout", async () => {
    mockFetch(async (_url, init) => {
      await new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        setTimeout(resolve, 5000);
      });
      return { body: {} };
    });
    await expect(httpJson("http://x/slow", { timeoutMs: 20 })).rejects.toThrow(/timed out after 20 ms/);
  });
});

describe("probe", () => {
  it("is true for 2xx and false for errors", async () => {
    mockFetch((url) => (url.includes("up") ? { body: {} } : { status: 500 }));
    expect(await probe("http://up/", 100)).toBe(true);
    expect(await probe("http://down/", 100)).toBe(false);
  });
});

describe("httpSse", () => {
  it("emits data payloads across chunk boundaries and stops at [DONE]", async () => {
    mockFetch(() => ({
      chunks: ['data: {"a":1}\n\nda', 'ta: {"a":2}\n\n: comment\n', "data: [DONE]\n\ndata: {\"a\":3}\n\n"],
    }));
    const seen: string[] = [];
    await httpSse("http://x/s", { method: "POST", body: "{}" }, (d) => {
      seen.push(d);
    });
    expect(seen).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("keeps a slow-but-steady stream alive past the idle timeout but kills a stalled one", async () => {
    mockFetch(() => ({ chunks: ["data: 1\n", "data: 2\n", "data: 3\n", "data: 4\n"], chunkDelayMs: 30 }));
    const seen: string[] = [];
    await httpSse("http://x/s", { timeoutMs: 0, idleTimeoutMs: 80 }, (d) => {
      seen.push(d);
    });
    expect(seen).toEqual(["1", "2", "3", "4"]);

    mockFetch(() => ({ chunks: ["data: 1\n", "data: 2\n"], chunkDelayMs: 200 }));
    await expect(httpSse("http://x/s", { timeoutMs: 0, idleTimeoutMs: 50 }, () => undefined)).rejects.toThrow(
      /idle/,
    );
  });
});

describe("httpNdjson", () => {
  it("parses objects and surfaces in-stream errors", async () => {
    mockFetch(() => ({ chunks: ['{"status":"a"}\n{"sta', 'tus":"b"}\n'] }));
    const seen: unknown[] = [];
    await httpNdjson("http://x/n", {}, (o) => {
      seen.push(o);
    });
    expect(seen).toEqual([{ status: "a" }, { status: "b" }]);

    mockFetch(() => ({ chunks: ['{"error":"pull failed: no such model"}\n'] }));
    await expect(httpNdjson("http://x/n", {}, () => undefined)).rejects.toThrow(/no such model/);
  });
});
