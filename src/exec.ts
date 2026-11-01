import { spawn } from "node:child_process";

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Kill the child after this long. <= 0 disables. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with each stdout/stderr chunk (e.g. to parse progress). */
  onOutput?: (chunk: string) => void;
}

/**
 * Run a command without blocking the event loop. stdin is closed so a CLI
 * that prompts interactively fails fast instead of hanging. Never uses a
 * shell, so arguments are passed through verbatim.
 */
export function runCommand(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ status: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    const kill = (reason: string) => {
      stderr += `${stderr ? "\n" : ""}${reason}`;
      child.kill();
      finish({ status: 124, stdout, stderr });
    };
    const timeoutMs = opts.timeoutMs ?? 0;
    const timer = timeoutMs > 0 ? setTimeout(() => kill(`${cmd} timed out after ${timeoutMs} ms`), timeoutMs) : undefined;
    const onAbort = () => kill(`${cmd} cancelled`);
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout += d;
      opts.onOutput?.(d);
    });
    child.stderr?.on("data", (d: string) => {
      stderr += d;
      opts.onOutput?.(d);
    });
    child.on("error", (err) => finish({ status: 127, stdout, stderr: stderr || err.message }));
    child.on("close", (code) => finish({ status: code ?? 1, stdout, stderr }));
  });
}
