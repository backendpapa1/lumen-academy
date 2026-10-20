import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import type { UsageEvent } from "../usage/meter.js";
import type { ResolvedSpec } from "./spec.js";

export interface UsageSink {
  record(e: UsageEvent): unknown;
}

interface TokenCounts {
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
}

/** Reads token usage from a chat LLMResult (usage_metadata first, llmOutput second). */
export function extractUsage(output: LLMResult): TokenCounts {
  const gen = output.generations[0]?.[0] as
    | {
        message?: {
          usage_metadata?: {
            input_tokens?: number;
            output_tokens?: number;
            input_token_details?: { cache_read?: number };
          };
        };
      }
    | undefined;
  const meta = gen?.message?.usage_metadata;
  if (meta) {
    return {
      inputTokens: meta.input_tokens,
      outputTokens: meta.output_tokens,
      cachedTokens: meta.input_token_details?.cache_read,
    };
  }
  const tu = (output.llmOutput as { tokenUsage?: Record<string, number> } | undefined)?.tokenUsage;
  return { inputTokens: tu?.promptTokens, outputTokens: tu?.completionTokens };
}

/** Attached to every model the factory builds, so no call escapes the meter. */
export class UsageCallback extends BaseCallbackHandler {
  name = "lumen-usage";
  private readonly started = new Map<string, number>();

  constructor(
    private readonly spec: ResolvedSpec,
    private readonly sink: UsageSink,
  ) {
    super();
  }

  override handleChatModelStart(_llm: unknown, _messages: unknown, runId: string): void {
    this.started.set(runId, performance.now());
  }

  override handleLLMStart(_llm: unknown, _prompts: unknown, runId: string): void {
    this.started.set(runId, performance.now());
  }

  override handleLLMEnd(output: LLMResult, runId: string): void {
    this.flush(runId, extractUsage(output));
  }

  override handleLLMError(_err: unknown, runId: string): void {
    // Failed calls may still bill; we don't know how much, so log them with no tokens.
    this.flush(runId, {});
  }

  private flush(runId: string, tokens: TokenCounts): void {
    const start = this.started.get(runId);
    this.started.delete(runId);
    this.sink.record({
      agent: this.spec.agent,
      provider: this.spec.provider,
      model: this.spec.model,
      ...tokens,
      latencyMs: start === undefined ? undefined : performance.now() - start,
      fallbackUsed: this.spec.isFallback,
    });
  }
}
