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
  // timeoutMs <= 0 disables the timeout entirely: no AbortController, no abort.
  const useTimeout = timeoutMs > 0;
  const controller = useTimeout ? new AbortController() : undefined;
  const timer = useTimeout ? setTimeout(() => controller!.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller?.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new HttpError(res.status, text, `HTTP ${res.status} for ${method} ${url}`);
    }
    return text;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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

/**
 * POST/GET an SSE (text/event-stream) endpoint and invoke onEvent for each
 * `data:` payload. Stops when the stream ends or a payload equals `[DONE]`.
 * Throws HttpError on non-2xx before the body is consumed.
 */
export async function httpSse(
  url: string,
  opts: HttpOptions,
  onEvent: (data: string) => void | Promise<void>,
): Promise<void> {
  const { method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const useTimeout = timeoutMs > 0;
  const controller = useTimeout ? new AbortController() : undefined;
  const timer = useTimeout ? setTimeout(() => controller!.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: "text/event-stream",
        ...headers,
        ...(body !== undefined && headers["Content-Type"] === undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body,
      signal: controller?.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new HttpError(res.status, text, `HTTP ${res.status} for ${method} ${url}`);
    }
    if (!res.body) {
      throw new Error(`SSE response from ${url} had no body`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trimStart();
        if (data === "" || data === "[DONE]") {
          if (data === "[DONE]") return;
          continue;
        }
        await onEvent(data);
      }
    }
    if (buffer.startsWith("data:")) {
      const data = buffer.slice(5).trimStart();
      if (data && data !== "[DONE]") await onEvent(data);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
