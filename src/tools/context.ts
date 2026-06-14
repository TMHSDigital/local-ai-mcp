import type { Config } from "../config.js";
import type { HardwareProbe } from "../hardware/index.js";
import type { ProviderManager } from "../providers/manager.js";

export interface ToolContext {
  manager: ProviderManager;
  hardware: HardwareProbe;
  config: Config;
}
