export class HttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120000;

export async function httpText(url: string, opts: HttpOptions = {}): Promise<string> {
  const { method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new HttpError(res.status, text, `HTTP ${res.status} for ${method} ${url}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function httpJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(opts.headers ?? {}),
  };
  if (opts.body !== undefined && headers["Content-Type"] === undefined) {
    headers["Content-Type"] = "application/json";
  }
  const text = await httpText(url, { ...opts, headers });
  if (text.trim() === "") {
    return {} as T;
  }
  return JSON.parse(text) as T;
}

export async function probe(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
