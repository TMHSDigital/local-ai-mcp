import { describe, expect, it } from "vitest";
import { inferKind, loadConfig, normalizeHost } from "../config.js";

describe("loadConfig", () => {
  it("registers the always-on local runtimes with defaults", () => {
    const c = loadConfig({});
    expect(c.providers.map((p) => [p.name, p.host])).toEqual([
      ["ollama", "http://localhost:11434"],
      ["lmstudio", "http://localhost:1234"],
      ["llamacpp", "http://localhost:8080"],
      ["dockermodelrunner", "http://localhost:12434"],
    ]);
    expect(c.allowHostedFallback).toBe(false);
    expect(c.allowNetworkSearch).toBe(true);
    expect(c.requestTimeoutMs).toBe(120000);
    expect(c.detectTimeoutMs).toBe(1500);
    expect(c.pullTimeoutMs).toBe(3600000);
    expect(c.streamIdleTimeoutMs).toBe(60000);
    expect(c.streamMaxMs).toBe(1800000);
    expect(c.cacheTtlMs).toBe(10000);
  });

  it("adds a scheme and strips trailing slashes", () => {
    expect(normalizeHost("localhost:11434/")).toBe("http://localhost:11434");
    expect(normalizeHost("https://x.test///")).toBe("https://x.test");
  });

  it("registers moonshot only when a key is set, as hosted", () => {
    expect(loadConfig({}).providers.some((p) => p.type === "moonshot")).toBe(false);
    const m = loadConfig({ MOONSHOT_API_KEY: " k " }).providers.find((p) => p.type === "moonshot");
    expect(m).toMatchObject({ apiKey: "k", kind: "hosted", host: "https://api.moonshot.ai/v1" });
  });

  it("registers opt-in runtimes when their host is set", () => {
    const c = loadConfig({
      OPENAI_COMPAT_HOST: "http://localhost:8000/v1",
      MLX_HOST: "localhost:8081",
      VLLM_HOST: "http://gpu-box.local:8000",
      FOUNDRY_LOCAL_HOST: "http://localhost:5272",
    });
    expect(c.providers.map((p) => p.name)).toEqual(
      expect.arrayContaining(["openaicompat", "mlx", "vllm", "foundrylocal"]),
    );
  });

  it("disables providers by name or type", () => {
    const c = loadConfig({ LOCAL_AI_DISABLE: "lmstudio, dockermodelrunner" });
    expect(c.providers.map((p) => p.name)).toEqual(["ollama", "llamacpp"]);
  });

  it("parses extra instances from LOCAL_AI_PROVIDERS", () => {
    const c = loadConfig({
      LOCAL_AI_PROVIDERS: JSON.stringify([
        { type: "ollama", name: "ollama-gpu2", host: "192.168.1.20:11434" },
        { type: "openaicompat", name: "remote", host: "https://api.example.com/v1", apiKey: "x" },
      ]),
    });
    expect(c.providers.find((p) => p.name === "ollama-gpu2")).toMatchObject({
      type: "ollama",
      host: "http://192.168.1.20:11434",
    });
    expect(c.providers.find((p) => p.name === "remote")?.apiKey).toBe("x");
  });

  it("rejects bad LOCAL_AI_PROVIDERS entries and duplicate names", () => {
    expect(() => loadConfig({ LOCAL_AI_PROVIDERS: "{" })).toThrow(/not valid JSON/);
    expect(() => loadConfig({ LOCAL_AI_PROVIDERS: '[{"type":"nope","host":"x"}]' })).toThrow(/type must be/);
    expect(() => loadConfig({ LOCAL_AI_PROVIDERS: '[{"type":"ollama","host":"x"}]' })).toThrow(/Duplicate provider name "ollama"/);
  });

  it("parses booleans and timeouts", () => {
    const c = loadConfig({
      LOCAL_AI_ALLOW_HOSTED_FALLBACK: "true",
      LOCAL_AI_DISABLE_NETWORK_SEARCH: "1",
      LOCAL_AI_PULL_TIMEOUT_MS: "0",
      LOCAL_AI_REQUEST_TIMEOUT_MS: "-5",
    });
    expect(c.allowHostedFallback).toBe(true);
    expect(c.allowNetworkSearch).toBe(false);
    expect(c.pullTimeoutMs).toBe(0);
    expect(c.requestTimeoutMs).toBe(120000);
  });
});

describe("inferKind", () => {
  it.each([
    ["http://localhost:11434", "local"],
    ["http://127.0.0.1:1234", "local"],
    ["http://[::1]:8080", "local"],
    ["http://192.168.1.5:8000", "local"],
    ["http://10.0.0.2", "local"],
    ["http://172.20.0.1", "local"],
    ["http://100.101.1.2", "local"],
    ["http://gpu-box.local:8000", "local"],
    ["http://host.docker.internal:11434", "local"],
    ["https://api.moonshot.ai/v1", "hosted"],
    ["http://8.8.8.8", "hosted"],
    ["http://172.32.0.1", "hosted"],
    ["not a url", "hosted"],
  ])("%s -> %s", (host, kind) => {
    expect(inferKind(host)).toBe(kind);
  });
});
