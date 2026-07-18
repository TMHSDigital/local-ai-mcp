import type { Config } from "../config.js";
import { LlamaCppProvider } from "./llamacpp.js";
import { LMStudioProvider } from "./lmstudio.js";
import { MoonshotProvider } from "./moonshot.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAICompatProvider } from "./openaicompat.js";
import type { Provider, ProviderId } from "./types.js";

export class ProviderManager {
  readonly providers: Provider[];

  constructor(config: Config) {
    this.providers = [
      new OllamaProvider(config.ollamaHost),
      new LMStudioProvider(config.lmstudioHost),
      new LlamaCppProvider(config.llamacppHost),
      new MoonshotProvider(config.moonshotHost, config.moonshotApiKey),
    ];
    if (config.openaiCompatHost) {
      this.providers.push(
        new OpenAICompatProvider(config.openaiCompatHost, config.openaiCompatApiKey),
      );
    }
  }

  get(id: string): Provider | undefined {
    return this.providers.find((p) => p.id === (id as ProviderId));
  }

  async detected(timeoutMs: number): Promise<Provider[]> {
    const results = await Promise.all(
      this.providers.map(async (p) => ({ provider: p, live: await p.detect(timeoutMs) })),
    );
    return results.filter((r) => r.live).map((r) => r.provider);
  }

  async resolve(providerArg: string | undefined, timeoutMs: number): Promise<Provider[]> {
    if (providerArg) {
      const p = this.get(providerArg);
      if (!p) {
        throw new Error(
          `Unknown provider: ${providerArg}. Known providers: ${this.providers
            .map((x) => x.id)
            .join(", ")}`,
        );
      }
      return [p];
    }
    return this.detected(timeoutMs);
  }
}
