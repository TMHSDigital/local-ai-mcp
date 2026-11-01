import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { register as registerCatalog } from "./catalog.js";
import { register as registerDelegation } from "./delegation.js";
import { register as registerDiscovery } from "./discovery.js";
import { register as registerLifecycle } from "./lifecycle.js";
import { register as registerOps } from "./ops.js";
import { registerResourcesAndPrompts } from "./resources.js";

export function registerAll(server: McpServer, ctx: ToolContext): void {
  if (!ctx.server) ctx.server = server.server;
  const notifyLoaded = registerResourcesAndPrompts(server, ctx);
  const previous = ctx.onStateChange;
  ctx.onStateChange = () => {
    previous?.();
    notifyLoaded();
  };
  registerDiscovery(server, ctx);
  registerLifecycle(server, ctx);
  registerOps(server, ctx);
  registerCatalog(server, ctx);
  registerDelegation(server, ctx);
}
