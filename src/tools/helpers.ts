import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Provider, RequestOptions } from "../providers/types.js";
import type { ToolContext } from "./context.js";

export type ToolResult = CallToolResult;
export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Success: pretty JSON text for display plus structuredContent for machines. */
export function ok(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

export function fail(message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Wrap a handler so thrown errors become isError results. */
export function safe<A>(
  fn: (args: A, extra: Extra) => Promise<ToolResult>,
): (args: A, extra: Extra) => Promise<ToolResult> {
  return async (args, extra) => {
    try {
      return await fn(args, extra);
    } catch (err) {
      return fail(errMsg(err));
    }
  };
}

/** Request options carrying the MCP request's cancellation signal. */
export function reqOpts(timeoutMs: number, extra?: Extra): RequestOptions {
  return { timeoutMs, ...(extra?.signal ? { signal: extra.signal } : {}) };
}

/**
 * Returns a progress sender when the client supplied a progressToken,
 * otherwise undefined. Notification failures never fail the tool call.
 */
export function progressSender(
  extra: Extra | undefined,
): ((progress: number, total?: number, message?: string) => Promise<void>) | undefined {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra) return undefined;
  return async (progress, total, message) => {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress,
          ...(total !== undefined ? { total } : {}),
          ...(message !== undefined ? { message } : {}),
        },
      });
    } catch {
      // ignore: progress is best-effort
    }
  };
}

/**
 * Aggregate per-provider results keyed by provider name, capturing errors per
 * provider rather than failing the whole call. Errors also drop the
 * provider's cached detection so the next call re-probes it.
 */
export async function aggregate<T>(
  ctx: ToolContext,
  providers: Provider[],
  fn: (p: Provider) => Promise<T>,
): Promise<Record<string, T | { error: string }>> {
  const entries = await Promise.all(
    providers.map(async (p) => {
      try {
        return [p.name, await fn(p)] as const;
      } catch (err) {
        ctx.manager.invalidate(p.name);
        return [p.name, { error: errMsg(err) }] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/** Zod schema for a provider argument, enumerating configured instance names. */
export function providerArg(ctx: ToolContext, what = "Provider instance name") {
  const names = ctx.manager.names();
  const desc = `${what}. Omit to let the server choose (local providers only, unless LOCAL_AI_ALLOW_HOSTED_FALLBACK is set).`;
  return names.length > 0
    ? z.enum(names as [string, ...string[]]).describe(desc)
    : z.string().describe(desc);
}

/** Loose output schemas: document the top-level shape without over-constraining. */
export const anyRecord = z.record(z.string(), z.unknown());
export const perProvider = z.record(z.string(), z.unknown());

export type ServerLike = Pick<McpServer, "registerTool"> & { server?: McpServer["server"] };
