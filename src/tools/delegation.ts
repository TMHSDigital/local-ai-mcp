import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { providerIdZod } from "./provider-id.js";
import type { ToolContext } from "./context.js";
import { errMsg, fail, ok } from "./helpers.js";

export function register(server: McpServer, ctx: ToolContext): void {
  const { manager, config } = ctx;

  server.tool(
    "complete",
    "DELEGATED INFERENCE: Offload a text/chat completion to a local model runtime for cost savings and privacy (data never leaves the machine). This is NOT a chat feature for the user; it delegates work to a local LLM. Provide either prompt or messages. Streams tokens via MCP progress notifications when the client supplies a progressToken (stream defaults to true). Without a provider arg, uses the first detected provider.",
    {
      model: z.string().describe("Model id/name to run the completion on"),
      prompt: z.string().optional().describe("Plain prompt text (alternative to messages)"),
      messages: z
        .array(z.object({ role: z.string(), content: z.string() }))
        .optional()
        .describe("Chat-style messages (alternative to prompt)"),
      maxTokens: z.number().optional().describe("Maximum tokens to generate"),
      temperature: z.number().optional().describe("Sampling temperature"),
      stop: z.array(z.string()).optional().describe("Stop sequences"),
      stream: z
        .boolean()
        .optional()
        .describe(
          "Stream tokens from the provider (default true). Progress notifications are sent when the client provides a progressToken.",
        ),
      provider: providerIdZod.optional().describe("Optional provider id"),
    },
    async ({ model, prompt, messages, maxTokens, temperature, stop, stream, provider }, extra) => {
      try {
        if (!prompt && (!messages || messages.length === 0)) {
          return fail("Provide either 'prompt' or non-empty 'messages'.");
        }
        const providers = await manager.resolve(provider, config.detectTimeoutMs);
        if (providers.length === 0) {
          return fail("No live providers detected to run the completion.");
        }
        const p = providers[0];
        const wantStream = stream !== false;
        let progress = 0;
        const onChunk = wantStream
          ? async (chunk: { text: string; done: boolean }) => {
              if (!chunk.text || extra._meta?.progressToken === undefined) return;
              progress += 1;
              await extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken: extra._meta.progressToken,
                  progress,
                  message: chunk.text,
                },
              });
            }
          : undefined;
        const result = await p.complete(
          { model, prompt, messages, maxTokens, temperature, stop },
          config.requestTimeoutMs,
          onChunk,
        );
        return ok(result);
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  );

  server.tool(
    "embed",
    "DELEGATED EMBEDDINGS: Offload embedding generation to a local model runtime for cost savings and privacy. Accepts a single string or an array of texts. Without a provider arg, uses the first detected provider.",
    {
      model: z.string().describe("Embedding model id/name"),
      input: z
        .union([z.string(), z.array(z.string())])
        .describe("Text or array of texts to embed"),
      provider: providerIdZod.optional().describe("Optional provider id"),
    },
    async ({ model, input, provider }) => {
      try {
        const providers = await manager.resolve(provider, config.detectTimeoutMs);
        if (providers.length === 0) {
          return fail("No live providers detected to generate embeddings.");
        }
        const p = providers[0];
        const result = await p.embed({ model, input }, config.requestTimeoutMs);
        return ok(result);
      } catch (err) {
        return fail(errMsg(err));
      }
    },
  );
}
