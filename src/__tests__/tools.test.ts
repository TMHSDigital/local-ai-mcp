import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import type { HardwareProbe } from "../hardware/index.js";
import { ProviderManager } from "../providers/manager.js";
import type { ToolContext } from "../tools/context.js";
import { registerAll } from "../tools/index.js";
import { removeModelGuarded } from "../tools/helpers.js";

describe("remove confirm gate", () => {
  it("refuses without confirm:true and does not call remove", async () => {
    const remove = vi.fn(async () => ({ removed: true }));
    const guarded = await removeModelGuarded(false, "llama3.2:3b", remove);
    expect(guarded.refused).toBe(true);
    if (guarded.refused) expect(guarded.message).toMatch(/confirm:true/);
    expect(remove).not.toHaveBeenCalled();
  });

  it("proceeds when confirm:true", async () => {
    const remove = vi.fn(async () => ({ removed: true }));
    const guarded = await removeModelGuarded(true, "llama3.2:3b", remove);
    expect(guarded.refused).toBe(false);
    expect(remove).toHaveBeenCalledOnce();
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
