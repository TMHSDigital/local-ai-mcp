export interface Config {
  ollamaHost: string;
  lmstudioHost: string;
  requestTimeoutMs: number;
  detectTimeoutMs: number;
  pullTimeoutMs: number;
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

// Like parseIntEnv but allows 0 (used to disable a timeout entirely).
function parseTimeoutEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    ollamaHost: normalizeHost(env.OLLAMA_HOST ?? "http://localhost:11434"),
    lmstudioHost: normalizeHost(env.LMSTUDIO_HOST ?? "http://localhost:1234"),
    requestTimeoutMs: parseIntEnv(env.LOCAL_AI_REQUEST_TIMEOUT_MS, 120000),
    detectTimeoutMs: parseIntEnv(env.LOCAL_AI_DETECT_TIMEOUT_MS, 1500),
    pullTimeoutMs: parseTimeoutEnv(env.LOCAL_AI_PULL_TIMEOUT_MS, 3600000),
  };
}
