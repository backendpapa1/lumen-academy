import OpenAI from "openai";
import { activeProfile, type ModelsConfig } from "@lumen/shared";
import type { UsageSink } from "../models/usage-callback.js";

export const EMBEDDING_DIMS = 1536; // chunk_vec / message_vec are FLOAT[1536]

export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface OpenAIEmbedderDeps {
  config: ModelsConfig;
  env: Record<string, string | undefined>;
  meter?: UsageSink & { assertCanCall(): void };
  batchSize?: number;
  /** For tests. */
  client?: Pick<OpenAI, "embeddings">;
}

/** text-embedding-3-small via the OpenAI SDK (its response carries token usage for the meter). */
export class OpenAIEmbedder implements Embedder {
  private readonly client: Pick<OpenAI, "embeddings">;
  private readonly model: string;
  private readonly batchSize: number;

  constructor(private readonly deps: OpenAIEmbedderDeps) {
    const spec = activeProfile(deps.config).embeddings;
    const provider = deps.config.providers.openai;
    this.model = spec.model;
    this.batchSize = deps.batchSize ?? 100;
    this.client =
      deps.client ??
      new OpenAI({
        apiKey: deps.env[provider.apiKeyEnv],
        baseURL: provider.baseURL,
        timeout: provider.timeoutMs,
        maxRetries: 1,
      });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      this.deps.meter?.assertCanCall();
      const batch = texts.slice(i, i + this.batchSize);
      const started = performance.now();
      const res = await this.client.embeddings.create({ model: this.model, input: batch });
      this.deps.meter?.record({
        agent: "embeddings",
        provider: "openai",
        model: this.model,
        inputTokens: res.usage?.prompt_tokens,
        latencyMs: performance.now() - started,
      });
      const sorted = [...res.data].sort((a, b) => a.index - b.index);
      for (const d of sorted) {
        if (d.embedding.length !== EMBEDDING_DIMS) {
          throw new Error(`embedding has ${d.embedding.length} dims, expected ${EMBEDDING_DIMS}`);
        }
        out.push(Float32Array.from(d.embedding));
      }
    }
    return out;
  }
}
