import { describe, expect, it } from "vitest";
import { runCommand } from "../exec.js";

const node = process.execPath;

describe("runCommand", () => {
  it("captures stdout and exit code", async () => {
    const r = await runCommand(node, ["-e", "process.stdout.write('hi'); process.exit(3)"]);
    expect(r).toMatchObject({ status: 3, stdout: "hi" });
  });

  it("streams output chunks to onOutput", async () => {
    const chunks: string[] = [];
    await runCommand(node, ["-e", "console.log('10%'); console.log('100%')"], { onOutput: (c) => chunks.push(c) });
    expect(chunks.join("")).toMatch(/10%[\s\S]*100%/);
  });

  it("kills the child on timeout without blocking the event loop", async () => {
    let ticks = 0;
    const iv = setInterval(() => ticks++, 10);
    const r = await runCommand(node, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 });
    clearInterval(iv);
    expect(r.status).toBe(124);
    expect(r.stderr).toMatch(/timed out/);
    expect(ticks).toBeGreaterThan(3);
  });

  it("closes stdin so interactive prompts fail fast", async () => {
    const r = await runCommand(node, ["-e", "process.stdin.on('data',()=>{}); process.stdin.on('end',()=>process.exit(7))"], {
      timeoutMs: 5000,
    });
    expect(r.status).toBe(7);
  });

  it("honours an abort signal", async () => {
    const ac = new AbortController();
    const p = runCommand(node, ["-e", "setTimeout(() => {}, 10000)"], { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    expect((await p).stderr).toMatch(/cancelled/);
  });

  it("reports a missing binary instead of throwing", async () => {
    const r = await runCommand("definitely-not-a-real-binary-xyz", []);
    expect(r.status).not.toBe(0);
  });
});
