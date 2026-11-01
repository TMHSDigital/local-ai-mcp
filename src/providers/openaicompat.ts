import { OpenAICompatibleProvider } from "./base.js";

/**
 * Generic OpenAI-compatible adapter. Opt-in via OPENAI_COMPAT_HOST (Jan,
 * text-generation-webui, LocalAI, or any /v1 server) or LOCAL_AI_PROVIDERS.
 * The host should include the /v1 suffix when the server uses that layout.
 * Its kind (local vs hosted) is inferred from the host unless overridden.
 */
export class OpenAICompatProvider extends OpenAICompatibleProvider {
  readonly type = "openaicompat" as const;
}
