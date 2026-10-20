import {
  activeProfile,
  type AgentName,
  type ModelSpec,
  type ModelsConfig,
  type Provider,
  type TextRole,
} from "@lumen/shared";

export interface ResolvedSpec {
  agent: AgentName;
  role: TextRole;
  provider: Provider;
  model: string;
  thinking?: "on" | "off";
  reasoningEffort?: ModelSpec["reasoningEffort"];
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  sampleRate?: number;
  /** True when this spec came from the fallback chain, not the profile. */
  isFallback: boolean;
}

export interface ResolveOptions {
  /** Replace the agent's role, e.g. "fastest" when the budget guard degrades. */
  role?: TextRole;
}

// Used only when a fallback crosses providers and so can't inherit these from
// the primary spec. Mirrors the openai/deepseek profiles in config/models.yaml.
const ROLE_THINKING: Record<TextRole, "on" | "off"> = {
  fastest: "off",
  fast: "off",
  standard: "on",
  heavy: "on",
};
const ROLE_EFFORT: Record<TextRole, ModelSpec["reasoningEffort"]> = {
  fastest: undefined,
  fast: "none",
  standard: "low",
  heavy: "medium",
};

export const specId = (s: { provider: Provider; model: string }) => `${s.provider}:${s.model}`;

/** Agent override → role → active profile. */
export function resolveSpec(
  cfg: ModelsConfig,
  agent: AgentName,
  opts: ResolveOptions = {},
): ResolvedSpec {
  const override = cfg.agents[agent];
  const role = opts.role ?? override.role;
  const base = activeProfile(cfg)[role];
  return finalize({
    agent,
    role,
    provider: base.provider,
    model: base.model,
    thinking: base.thinking,
    reasoningEffort: base.reasoningEffort,
    temperature: override.temperature ?? base.temperature,
    maxOutputTokens: override.maxOutputTokens ?? base.maxOutputTokens,
    timeoutMs: base.timeoutMs,
    sampleRate: override.sampleRate,
    isFallback: false,
  });
}

/** The role's fallback chain with the primary removed, in config order. */
export function fallbackSpecs(cfg: ModelsConfig, primary: ResolvedSpec): ResolvedSpec[] {
  return cfg.fallbacks[primary.role]
    .filter((id) => id !== specId(primary))
    .map((id) => {
      const [provider, model] = splitId(id);
      const sameProvider = provider === primary.provider;
      return finalize({
        ...primary,
        provider,
        model,
        thinking:
          provider === "deepseek"
            ? sameProvider
              ? primary.thinking
              : ROLE_THINKING[primary.role]
            : undefined,
        reasoningEffort:
          provider === "openai"
            ? sameProvider
              ? primary.reasoningEffort
              : ROLE_EFFORT[primary.role]
            : undefined,
        isFallback: true,
      });
    });
}

function splitId(id: string): [Provider, string] {
  const i = id.indexOf(":");
  return [id.slice(0, i) as Provider, id.slice(i + 1)];
}

function finalize(spec: ResolvedSpec): ResolvedSpec {
  const out = { ...spec };
  if (out.provider !== "deepseek") delete out.thinking;
  if (out.provider === "deepseek") {
    // DeepSeek defaults to thinking on; always send the flag explicitly.
    out.thinking ??= ROLE_THINKING[out.role];
    // DeepSeek only takes an effort with thinking on (ADR-007).
    if (out.thinking !== "on") delete out.reasoningEffort;
    // Thinking mode ignores temperature; don't pretend we set it.
    if (out.thinking === "on") delete out.temperature;
  }
  return out;
}
