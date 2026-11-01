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
  /** Overall deadline for the request. <= 0 disables it. */
  timeoutMs?: number;
  /**
   * Streaming only: abort when no bytes arrive for this long. Resets on every
   * chunk, so a long but healthy generation is never cut off. <= 0 disables.
   */
  idleTimeoutMs?: number;
  /** Caller cancellation (e.g. the MCP request's AbortSignal). */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Combines the caller's signal with an overall deadline and an optional idle
 * timer. `touch()` resets the idle timer; `dispose()` clears all timers.
 */
function makeAbort(opts: HttpOptions) {
  const controller = new AbortController();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const abort = (reason: string) => {
    if (!controller.signal.aborted) controller.abort(new Error(reason));
  };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (timeoutMs > 0) {
    timers.push(setTimeout(() => abort(`Request timed out after ${timeoutMs} ms`), timeoutMs));
  }
  let idle: ReturnType<typeof setTimeout> | undefined;
  const idleMs = opts.idleTimeoutMs ?? 0;
  const touch = () => {
    if (idleMs <= 0) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => abort(`Stream idle for ${idleMs} ms`), idleMs);
  };
  const onCallerAbort = () => abort("Request cancelled");
  if (opts.signal) {
    if (opts.signal.aborted) onCallerAbort();
    else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    touch,
    dispose() {
      for (const t of timers) clearTimeout(t);
      if (idle) clearTimeout(idle);
      opts.signal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

function rethrowAbort(err: unknown, signal: AbortSignal): never {
  if (signal.aborted && signal.reason instanceof Error) throw signal.reason;
  throw err;
}

export async function httpText(url: string, opts: HttpOptions = {}): Promise<string> {
  const { method = "GET", headers = {}, body } = opts;
  const ctl = makeAbort(opts);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new HttpError(res.status, text, `HTTP ${res.status} for ${method} ${url}`);
    }
    return text;
  } catch (err) {
    rethrowAbort(err, ctl.signal);
  } finally {
    ctl.dispose();
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

export async function probe(
  url: string,
  timeoutMs: number,
  opts: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<boolean> {
  const ctl = makeAbort({ timeoutMs, signal: opts.signal });
  try {
    const res = await fetch(url, { method: "GET", headers: opts.headers, signal: ctl.signal });
    // Release the body so the socket can be reused; ignore body errors.
    try {
      await res.body?.cancel();
    } catch {
      // ignore
    }
    return res.ok;
  } catch {
    return false;
  } finally {
    ctl.dispose();
  }
}

/**
 * Stream a response body line by line. Throws HttpError on non-2xx before the
 * body is consumed. `onLine` returning `false` stops reading early.
 */
export async function httpStreamLines(
  url: string,
  opts: HttpOptions,
  accept: string,
  onLine: (line: string) => boolean | void | Promise<boolean | void>,
): Promise<void> {
  const { method = "GET", headers = {}, body } = opts;
  const ctl = makeAbort(opts);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: accept,
        ...headers,
        ...(body !== undefined && headers["Content-Type"] === undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body,
      signal: ctl.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new HttpError(res.status, text, `HTTP ${res.status} for ${method} ${url}`);
    }
    if (!res.body) {
      throw new Error(`Streaming response from ${url} had no body`);
    }
    ctl.touch();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      ctl.touch();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if ((await onLine(line)) === false) {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") await onLine(buffer);
  } catch (err) {
    rethrowAbort(err, ctl.signal);
  } finally {
    ctl.dispose();
  }
}

/**
 * POST/GET an SSE (text/event-stream) endpoint and invoke onEvent for each
 * `data:` payload. Stops when the stream ends or a payload equals `[DONE]`.
 */
export async function httpSse(
  url: string,
  opts: HttpOptions,
  onEvent: (data: string) => void | Promise<void>,
): Promise<void> {
  await httpStreamLines(url, opts, "text/event-stream", async (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trimStart();
    if (data === "[DONE]") return false;
    if (data === "") return;
    await onEvent(data);
  });
}

/** Stream newline-delimited JSON (Ollama's native streaming format). */
export async function httpNdjson<T>(
  url: string,
  opts: HttpOptions,
  onObject: (obj: T) => void | Promise<void>,
): Promise<void> {
  await httpStreamLines(url, opts, "application/x-ndjson", async (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let obj: T;
    try {
      obj = JSON.parse(trimmed) as T;
    } catch {
      return;
    }
    const maybeErr = (obj as { error?: unknown }).error;
    if (typeof maybeErr === "string" && maybeErr) {
      throw new Error(maybeErr);
    }
    await onObject(obj);
  });
}
