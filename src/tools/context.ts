import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import type { HardwareProbe } from "../hardware/index.js";
import type { ProviderManager } from "../providers/manager.js";

export interface ToolContext {
  manager: ProviderManager;
  hardware: HardwareProbe;
  config: Config;
  /** Called after a tool changes runtime state (pull/remove/load/unload). */
  onStateChange?: () => void;
  /** The low-level server, for elicitation. Optional so tests can omit it. */
  server?: McpServer["server"];
}
