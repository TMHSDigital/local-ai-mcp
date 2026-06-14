export interface Config {
  ollamaHost: string;
  lmstudioHost: string;
  requestTimeoutMs: number;
  detectTimeoutMs: number;
}

function normalizeHost(value: string): string {
  let host = value.trim();
  if (!/^https?:\/\//i.test(host)) {
    host = `http://${host}`;
  }
  return host.replace(/\/+$/, "");
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    ollamaHost: normalizeHost(env.OLLAMA_HOST ?? "http://localhost:11434"),
    lmstudioHost: normalizeHost(env.LMSTUDIO_HOST ?? "http://localhost:1234"),
    requestTimeoutMs: parseIntEnv(env.LOCAL_AI_REQUEST_TIMEOUT_MS, 120000),
    detectTimeoutMs: parseIntEnv(env.LOCAL_AI_DETECT_TIMEOUT_MS, 1500),
  };
}
