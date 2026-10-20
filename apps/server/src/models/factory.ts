import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatOpenAI } from "@langchain/openai";
import type { AgentName, ModelsConfig } from "@lumen/shared";
import { isProviderFailure } from "./errors.js";
import { HealthRegistry } from "./health.js";
import { UsageCallback, type UsageSink } from "./usage-callback.js";
import {
  fallbackSpecs,
  resolveSpec,
  specId,
  type ResolveOptions,
  type ResolvedSpec,
} from "./spec.js";

// LangChain retries 6× by default with backoff, which would blow the latency
// budget and hide failures from the fallback chain. One retry, then fall back.
const MAX_RETRIES = 1;

export interface FactoryDeps {
  config: ModelsConfig;
  env: Record<string, string | undefined>;
  health?: HealthRegistry;
  /** Usage meter + budget guard. Every built model reports to it. */
  meter?: UsageSink & { budgetState(): string; assertCanCall(): void };
  /** Lets tests swap in fake models. */
  build?: (spec: ResolvedSpec) => BaseChatModel;
}

export interface Candidate {
  spec: ResolvedSpec;
  model: BaseChatModel;
}

export interface AttemptEvent {
  spec: ResolvedSpec;
  ok: boolean;
  latencyMs: number;
  error?: unknown;
  /** The provider just became unhealthy because of this failure. */
  markedUnhealthy?: boolean;
}

export class ModelFactory {
  readonly health: HealthRegistry;
  private readonly cache = new Map<string, BaseChatModel>();

  constructor(private readonly deps: FactoryDeps) {
    this.health = deps.health ?? new HealthRegistry();
  }

  /** Primary first, then fallbacks; healthy providers are tried before unhealthy ones. */
  candidates(agent: AgentName, opts: ResolveOptions = {}): Candidate[] {
    // Budget degrade: every role drops to the cheapest tier (docs/03 §8).
    if (!opts.role && this.deps.meter?.budgetState() === "degrade")
      opts = { ...opts, role: "fastest" };
    const primary = resolveSpec(this.deps.config, agent, opts);
    const all = [primary, ...fallbackSpecs(this.deps.config, primary)];
    const healthy = all.filter((s) => this.health.isHealthy(s.provider));
    const unhealthy = all.filter((s) => !this.health.isHealthy(s.provider));
    return [...healthy, ...unhealthy].map((spec) => ({ spec, model: this.model(spec) }));
  }

  /** The model to use right now, for callers that manage their own retries. */
  getModel(agent: AgentName, opts: ResolveOptions = {}): Candidate {
    this.deps.meter?.assertCanCall();
    const first = this.candidates(agent, opts)[0];
    if (!first) throw new Error(`no model candidates for ${agent}`);
    return first;
  }

  /**
   * Runs `fn` against each candidate until one succeeds. Provider failures
   * (timeouts, 429, 5xx, network) move to the next candidate and count against
   * that provider's health; any other error is rethrown immediately.
   */
  async run<T>(
    agent: AgentName,
    fn: (candidate: Candidate) => Promise<T>,
    opts: ResolveOptions & { onAttempt?: (e: AttemptEvent) => void } = {},
  ): Promise<T> {
    this.deps.meter?.assertCanCall();
    const errors: unknown[] = [];
    for (const candidate of this.candidates(agent, opts)) {
      const started = performance.now();
      try {
        const result = await fn(candidate);
        this.health.recordSuccess(candidate.spec.provider);
        opts.onAttempt?.({
          spec: candidate.spec,
          ok: true,
          latencyMs: performance.now() - started,
        });
        return result;
      } catch (error) {
        const latencyMs = performance.now() - started;
        if (!isProviderFailure(error)) {
          opts.onAttempt?.({ spec: candidate.spec, ok: false, latencyMs, error });
          throw error;
        }
        const markedUnhealthy = this.health.recordFailure(candidate.spec.provider);
        opts.onAttempt?.({ spec: candidate.spec, ok: false, latencyMs, error, markedUnhealthy });
        errors.push(error);
      }
    }
    throw new AggregateError(errors, `all model candidates failed for ${agent}`);
  }

  private model(spec: ResolvedSpec): BaseChatModel {
    const key = JSON.stringify(spec, Object.keys(spec).sort());
    let model = this.cache.get(key);
    if (!model) {
      model = (this.deps.build ?? ((s) => buildModel(s, this.deps)))(spec);
      this.cache.set(key, model);
    }
    return model;
  }
}

export function buildModel(
  spec: ResolvedSpec,
  deps: Pick<FactoryDeps, "config" | "env" | "meter">,
): BaseChatModel {
  const callbacks = deps.meter ? [new UsageCallback(spec, deps.meter)] : undefined;
  const provider = deps.config.providers[spec.provider];
  const apiKey = deps.env[provider.apiKeyEnv];
  if (!apiKey) throw new Error(`${provider.apiKeyEnv} is not set (needed for ${specId(spec)})`);

  if (spec.provider === "openai") {
    return new ChatOpenAI({
      model: spec.model,
      apiKey,
      configuration: { baseURL: provider.baseURL },
      temperature: spec.temperature,
      maxTokens: spec.maxOutputTokens,
      reasoning: spec.reasoningEffort ? { effort: spec.reasoningEffort } : undefined,
      timeout: spec.timeoutMs ?? provider.timeoutMs,
      maxRetries: MAX_RETRIES,
      streamUsage: true,
      callbacks,
    });
  }
  return new ChatDeepSeek({
    model: spec.model,
    apiKey,
    configuration: { baseURL: provider.baseURL },
    temperature: spec.temperature,
    maxTokens: spec.maxOutputTokens,
    // DeepSeek's thinking toggle and effort have no typed options; ChatDeepSeek
    // drops `reasoning`, so both go in the body (ADR-004, ADR-007).
    modelKwargs: {
      thinking: { type: spec.thinking === "on" ? "enabled" : "disabled" },
      ...(spec.reasoningEffort ? { reasoning_effort: spec.reasoningEffort } : {}),
    },
    timeout: spec.timeoutMs ?? provider.timeoutMs,
    maxRetries: MAX_RETRIES,
    streamUsage: true,
    callbacks,
  });
}
