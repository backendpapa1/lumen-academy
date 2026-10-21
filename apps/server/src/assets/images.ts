import OpenAI from "openai";
import { activeProfile, type ModelsConfig } from "@lumen/shared";
import type { UsageSink } from "../models/usage-callback.js";

// The one place that calls the OpenAI Images API (docs/07). Model comes from
// config/models.yaml (image role); every call is budget-guarded and metered.

export type ImageQuality = "low" | "medium" | "high";
export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";

export interface ImageRequest {
  prompt: string;
  size: ImageSize;
  quality: ImageQuality;
  transparent?: boolean;
  format?: "png" | "webp" | "jpeg";
  /** usage_log agent tag, e.g. "image:portrait". */
  agent?: string;
}

export interface GeneratedImage {
  bytes: Buffer;
  model: string;
  latencyMs: number;
  revisedPrompt?: string;
}

export interface ImageGenerator {
  readonly model: string;
  generate(req: ImageRequest): Promise<GeneratedImage>;
}

export interface OpenAIImagesDeps {
  config: ModelsConfig;
  env: Record<string, string | undefined>;
  meter?: UsageSink & { assertCanCall(): void };
  /** For tests. */
  client?: Pick<OpenAI, "images">;
}

export class OpenAIImages implements ImageGenerator {
  readonly model: string;
  private readonly client: Pick<OpenAI, "images">;

  constructor(private readonly deps: OpenAIImagesDeps) {
    const spec = activeProfile(deps.config).image;
    const provider = deps.config.providers.openai;
    this.model = spec.model;
    this.client =
      deps.client ??
      new OpenAI({
        apiKey: deps.env[provider.apiKeyEnv],
        baseURL: provider.baseURL,
        // Images take far longer than text; a medium portrait is ~20–40s.
        timeout: Math.max(provider.timeoutMs ?? 0, 120_000),
        maxRetries: 1,
      });
  }

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    this.deps.meter?.assertCanCall();
    const started = performance.now();
    const res = await this.client.images.generate({
      model: this.model,
      prompt: req.prompt,
      size: req.size,
      quality: req.quality,
      n: 1,
      output_format: req.format ?? "png",
      ...(req.transparent ? { background: "transparent" as const } : {}),
    });
    const latencyMs = performance.now() - started;
    this.deps.meter?.record({
      agent: req.agent ?? "image",
      provider: "openai",
      model: this.model,
      images: 1,
      imageQuality: req.quality,
      inputTokens: res.usage?.input_tokens,
      outputTokens: res.usage?.output_tokens,
      latencyMs,
    });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new Error("image response had no b64_json");
    return {
      bytes: Buffer.from(b64, "base64"),
      model: this.model,
      latencyMs,
      revisedPrompt: res.data?.[0]?.revised_prompt ?? undefined,
    };
  }
}
