import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ChatDeepSeek } from "@langchain/deepseek";
import { OpenAIEmbeddings } from "@langchain/openai";
import { TEXT_ROLES, type ModelsConfig, type Provider } from "@lumen/shared";
import { z } from "zod";
import type { ModelFactory } from "./factory.js";
import { structured } from "./structured.js";

export interface CheckLine {
  ok: boolean;
  /** Informational lines never fail the check. */
  info?: boolean;
  label: string;
  detail: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Every model id named anywhere in models.yaml (all profiles + fallbacks), by provider. */
export function configuredModelIds(cfg: ModelsConfig): Record<Provider, Set<string>> {
  const out: Record<Provider, Set<string>> = { openai: new Set(), deepseek: new Set() };
  for (const profile of Object.values(cfg.profiles)) {
    for (const spec of Object.values(profile)) out[spec.provider].add(spec.model);
  }
  for (const chain of Object.values(cfg.fallbacks)) {
    for (const id of chain) {
      const [provider, model] = id.split(":") as [Provider, string];
      out[provider].add(model);
    }
  }
  return out;
}

export async function listProviderModels(
  cfg: ModelsConfig,
  provider: Provider,
  apiKey: string,
  fetchImpl: Fetch = fetch,
): Promise<Set<string>> {
  const { baseURL, timeoutMs } = cfg.providers[provider];
  const res = await fetchImpl(`${baseURL.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET /models → HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  return new Set((body.data ?? []).map((m) => m.id));
}

/** Step 1: every configured id must exist at its provider. Never prints keys. */
export async function checkModelIds(
  cfg: ModelsConfig,
  env: Record<string, string | undefined>,
  fetchImpl: Fetch = fetch,
): Promise<CheckLine[]> {
  const lines: CheckLine[] = [];
  const wanted = configuredModelIds(cfg);
  for (const provider of ["openai", "deepseek"] as const) {
    if (wanted[provider].size === 0) continue;
    const keyVar = cfg.providers[provider].apiKeyEnv;
    const key = env[keyVar];
    if (!key) {
      lines.push({ ok: false, label: provider, detail: `${keyVar} is not set (add it to .env)` });
      continue;
    }
    let available: Set<string>;
    try {
      available = await listProviderModels(cfg, provider, key, fetchImpl);
    } catch (err) {
      lines.push({
        ok: false,
        label: provider,
        detail: `could not list models: ${(err as Error).message}`,
      });
      continue;
    }
    for (const model of [...wanted[provider]].sort()) {
      const ok = available.has(model);
      lines.push({
        ok,
        label: `${provider}:${model}`,
        detail: ok
          ? "listed"
          : "UNKNOWN: not in the provider's /models list. Fix config/models.yaml",
      });
    }
  }
  return lines;
}

const PingZ = z.object({ ok: z.boolean(), word: z.string().max(20) });

/** Step 2: one tiny structured-output call per text role in the active profile. */
export async function checkRoles(factory: ModelFactory): Promise<CheckLine[]> {
  const lines: CheckLine[] = [];
  for (const role of TEXT_ROLES) {
    const label = `role ${role}`;
    try {
      let used = "";
      const started = performance.now();
      const out = await factory.run(
        "classDirector",
        async (candidate) => {
          const { spec } = candidate;
          used = `${spec.provider}:${spec.model}${spec.isFallback ? " (FALLBACK)" : ""}`;
          return structured(candidate, PingZ, "ping").invoke([
            new HumanMessage('Return ok=true and word="lumen".'),
          ]);
        },
        { role },
      );
      const ms = Math.round(performance.now() - started);
      const parsed = PingZ.safeParse(out);
      lines.push({
        ok: parsed.success && parsed.data.ok,
        label,
        detail: parsed.success
          ? `${used} · structured output OK · ${ms}ms`
          : `${used} · bad output`,
      });
    } catch (err) {
      lines.push({ ok: false, label, detail: describeError(err) });
    }
  }
  return lines;
}

/** Step 3: embeddings model answers and has the dimension the vec0 tables expect. */
export async function checkEmbeddings(
  cfg: ModelsConfig,
  env: Record<string, string | undefined>,
  expectedDims = 1536,
): Promise<CheckLine> {
  const spec = cfg.profiles[cfg.profile].embeddings;
  const label = `embeddings ${spec.model}`;
  try {
    const embeddings = new OpenAIEmbeddings({
      model: spec.model,
      apiKey: env[cfg.providers.openai.apiKeyEnv],
      configuration: { baseURL: cfg.providers.openai.baseURL },
      maxRetries: 1,
    });
    const [v] = await embeddings.embedDocuments(["lumen"]);
    const dims = v?.length ?? 0;
    return { ok: dims === expectedDims, label, detail: `${dims} dims (expected ${expectedDims})` };
  } catch (err) {
    return { ok: false, label, detail: describeError(err) };
  }
}

/**
 * Step 4 (regression guard, ADR-004): multi-step tool loops on DeepSeek with
 * thinking on worked live on 20 Oct 2026 even though LangChain doesn't send
 * reasoning_content back. If this starts failing, deep agents on DeepSeek
 * thinking roles will break, so it fails the check.
 */
export async function probeDeepSeekThinkingToolLoop(
  cfg: ModelsConfig,
  env: Record<string, string | undefined>,
): Promise<CheckLine> {
  const label = "probe deepseek thinking + tool loop";
  const apiKey = env[cfg.providers.deepseek.apiKeyEnv];
  if (!apiKey) return { ok: true, info: true, label, detail: "skipped (no DeepSeek key)" };
  const add = tool(async ({ a, b }: { a: number; b: number }) => String(a + b), {
    name: "add",
    description: "Add two numbers.",
    schema: z.object({ a: z.number(), b: z.number() }),
  });
  // The DeepSeek profile's fast model, so no id is hard-coded here.
  const model = new ChatDeepSeek({
    model: cfg.profiles.deepseek.fast.model,
    apiKey,
    configuration: { baseURL: cfg.providers.deepseek.baseURL },
    modelKwargs: { thinking: { type: "enabled" } },
    maxRetries: 0,
    timeout: cfg.providers.deepseek.timeoutMs,
  }).bindTools([add]);
  try {
    const messages = [
      new HumanMessage("Use the add tool to add 2 and 3, then reply with the result."),
    ];
    const first = (await model.invoke(messages)) as AIMessage;
    const call = first.tool_calls?.[0];
    if (!call?.id)
      return { ok: true, info: true, label, detail: "inconclusive: model did not call the tool" };
    await model.invoke([
      ...messages,
      first,
      new ToolMessage({ tool_call_id: call.id, content: "5" }),
    ]);
    return { ok: true, label, detail: "two-step tool loop works with thinking on" };
  } catch (err) {
    return {
      ok: false,
      label,
      detail: `tool loop with thinking on FAILED (deep agents on DeepSeek thinking roles will break; see ADR-004): ${describeError(err)}`,
    };
  }
}

function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    return `all candidates failed: ${err.errors.map((e) => describeError(e)).join(" | ")}`;
  }
  if (err instanceof Error) {
    const status = (err as { status?: number }).status;
    return status ? `HTTP ${status}: ${err.message}` : err.message;
  }
  return String(err);
}
