import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import type { HardwareProbe } from "../hardware/index.js";
import { ProviderManager } from "../providers/manager.js";
import type { ToolContext } from "../tools/context.js";
import { registerAll } from "../tools/index.js";
import { removeModelGuarded } from "../tools/helpers.js";

describe("remove confirm gate", () => {
  it("refuses without confirm:true and does not call remove (provider supplied)", async () => {
    const remove = vi.fn(async () => ({ provider: "ollama", model: "llama3.2:3b", removed: true }));
    // The destructive remove is always scoped to a single provider; here the
    // gate must still refuse because confirm is false.
    const guarded = await removeModelGuarded(false, "llama3.2:3b", remove);
    expect(guarded.refused).toBe(true);
    if (guarded.refused) expect(guarded.message).toMatch(/confirm:true/);
    expect(remove).not.toHaveBeenCalled();
  });

  it("proceeds when confirm:true", async () => {
    const remove = vi.fn(async () => ({ provider: "ollama", model: "llama3.2:3b", removed: true }));
    const guarded = await removeModelGuarded(true, "llama3.2:3b", remove);
    expect(guarded.refused).toBe(false);
    expect(remove).toHaveBeenCalledOnce();
  });
});

describe("pull_model timeout", () => {
  it("invokes provider.pull with config.pullTimeoutMs (not requestTimeoutMs)", async () => {
    const config = {
      ...loadConfig({}),
      requestTimeoutMs: 120000,
      pullTimeoutMs: 999000,
    };
    const pull = vi.fn(async (model: string, _timeoutMs: number) => ({
      provider: "ollama" as const,
      model,
      status: "success",
    }));
    const fakeProvider = { id: "ollama", pull };
    const fakeManager = {
      resolve: vi.fn(async () => [fakeProvider]),
    } as unknown as ProviderManager;

    const hardware: HardwareProbe = {
      async getSystemResources() {
        return { platform: "linux", ramTotalBytes: 1, ramFreeBytes: 1, cpuCount: 1, gpus: [] };
      },
    };
    const ctx: ToolContext = { manager: fakeManager, hardware, config };

    // Capture the pull_model handler off a fake server.
    let pullHandler:
      | ((args: { model: string; provider?: string }) => Promise<unknown>)
      | undefined;
    const server = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool(name: string, _desc: string, _schema: unknown, handler: any) {
        if (name === "pull_model") pullHandler = handler;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as McpServer;

    registerAll(server, ctx);
    expect(pullHandler).toBeTypeOf("function");

    await pullHandler!({ model: "llama3.2:3b", provider: "ollama" });

    expect(pull).toHaveBeenCalledOnce();
    expect(pull.mock.calls[0][1]).toBe(999000);
    expect(pull.mock.calls[0][1]).not.toBe(config.requestTimeoutMs);
  });
});

describe("registerAll", () => {
  it("registers all 16 tools on the server", () => {
    const config = loadConfig({});
    const hardware: HardwareProbe = {
      async getSystemResources() {
        return {
          platform: "linux",
          ramTotalBytes: 1000,
          ramFreeBytes: 1000,
          cpuCount: 1,
          gpus: [],
        };
      },
    };
    const ctx: ToolContext = {
      manager: new ProviderManager(config),
      hardware,
      config,
    };
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const registered: string[] = [];
    const orig = server.tool.bind(server);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).tool = (name: string, ...rest: any[]) => {
      registered.push(name);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (orig as any)(name, ...rest);
    };
    registerAll(server, ctx);
    expect(registered).toHaveLength(16);
    expect(new Set(registered)).toEqual(
      new Set([
        "list_providers",
        "list_models",
        "list_loaded",
        "model_info",
        "pull_model",
        "remove_model",
        "load_model",
        "unload_model",
        "health_check",
        "system_resources",
        "fit_check",
        "benchmark",
        "search_available",
        "suggest_model",
        "complete",
        "embed",
      ]),
    );
  });
});
