import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearHfCache, groupGgufFiles, pickBestQuant, searchHuggingFace, type QuantFit } from "../catalog/huggingface.js";
import { GB, mockFetch, resources } from "./support.js";

const OPTS = { limit: 5, timeoutMs: 5000 };

beforeEach(() => clearHfCache());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function q(quant: string, sizeBytes: number, target: QuantFit["fit"]["target"]): QuantFit {
  return { quant, sizeBytes, files: [`x-${quant}.gguf`], fit: { fits: target !== "none", target, requiredBytes: sizeBytes } };
}

/** Fake HF API: search returns `hits`; each repo's info comes from `repos` (missing repo -> 500). */
function serveHf(hits: unknown, repos: Record<string, unknown>) {
  return mockFetch((url) => {
    if (url.includes("/api/models?")) return { body: hits };
    const repo = Object.keys(repos).find((r) => url.includes(`/api/models/${r}?`));
    return repo ? { body: repos[repo] } : { status: 500, text: "boom" };
  });
}

describe("pickBestQuant", () => {
  it("picks the largest partial when nothing fits on GPU", () => {
    expect(pickBestQuant([q("Q4", 4, "partial"), q("Q6", 6, "partial"), q("Q8", 8, "cpu")])?.quant).toBe("Q6");
  });

  it("picks the smallest cpu quant when only cpu targets remain", () => {
    expect(pickBestQuant([q("Q4", 4, "cpu"), q("Q8", 8, "cpu"), q("F16", 16, "none")])?.quant).toBe("Q4");
  });

  it("returns undefined when every quant is none", () => {
    expect(pickBestQuant([q("Q4", 4, "none"), q("Q8", 8, "none")])).toBeUndefined();
  });
});

describe("groupGgufFiles", () => {
  it("merges quant names case-insensitively", () => {
    const g = groupGgufFiles([
      { rfilename: "m-q4_k_m.gguf", size: 1 },
      { rfilename: "m-Q4_K_M.gguf", size: 2 },
    ]);
    expect(g).toEqual([{ quant: "Q4_K_M", sizeBytes: 3, files: ["m-q4_k_m.gguf", "m-Q4_K_M.gguf"] }]);
  });

  it("recognises IQ quants, nested paths, and skips files without size", () => {
    const g = groupGgufFiles([
      { rfilename: "m-IQ3_XXS.gguf", size: 3 },
      { rfilename: "sub/x-Q8_0.gguf", size: 8 },
      { rfilename: "m-Q5_K_M.gguf" },
      { rfilename: "m-Q6_K.gguf", size: 0 },
    ]);
    expect(g.map((x) => [x.quant, x.files])).toEqual([
      ["IQ3_XXS", ["m-IQ3_XXS.gguf"]],
      ["Q8_0", ["sub/x-Q8_0.gguf"]],
    ]);
  });
});

describe("searchHuggingFace", () => {
  const repo = (id: string, sizes: Record<string, number>) => ({
    id,
    siblings: Object.entries(sizes).map(([quant, size]) => ({ rfilename: `${id.split("/")[1]}-${quant}.gguf`, size })),
  });

  it("drops a repo whose info call fails and keeps the rest", async () => {
    serveHf([{ id: "a/broken" }, { id: "a/ok" }], { "a/ok": repo("a/ok", { Q4_K_M: 2 * GB }) });
    const out = await searchHuggingFace("x", resources(), OPTS);
    expect(out.map((r) => r.repo)).toEqual(["a/ok"]);
  });

  it("omits repos with no GGUF files", async () => {
    serveHf([{ id: "a/none" }, { id: "a/ok" }], {
      "a/none": { id: "a/none", siblings: [{ rfilename: "model.safetensors", size: 10 }] },
      "a/ok": repo("a/ok", { Q4_K_M: 2 * GB }),
    });
    expect((await searchHuggingFace("x", resources(), OPTS)).map((r) => r.repo)).toEqual(["a/ok"]);
  });

  it("returns [] when the search response is not an array", async () => {
    serveHf({ error: "x" }, {});
    expect(await searchHuggingFace("x", resources(), OPTS)).toEqual([]);
  });

  it("omits best when no quant can run", async () => {
    serveHf([{ id: "a/huge" }], { "a/huge": repo("a/huge", { Q4_K_M: 40 * GB }) });
    const hw = resources({ ramTotalBytes: 8 * GB, ramFreeBytes: 4 * GB });
    const [r] = await searchHuggingFace("x", hw, OPTS);
    expect(r.quants[0].fit.target).toBe("none");
    expect(r).not.toHaveProperty("best");
  });

  it("caches responses for one hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const calls = serveHf([{ id: "a/ok" }], { "a/ok": repo("a/ok", { Q4_K_M: 2 * GB }) });
    await searchHuggingFace("x", resources(), OPTS);
    expect(calls).toHaveLength(2);

    vi.setSystemTime(new Date("2026-01-01T00:59:59Z"));
    await searchHuggingFace("x", resources(), OPTS);
    expect(calls).toHaveLength(2);

    vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
    await searchHuggingFace("x", resources(), OPTS);
    expect(calls).toHaveLength(4);
  });
});
