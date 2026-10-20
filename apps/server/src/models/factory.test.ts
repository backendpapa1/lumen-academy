import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatOpenAI } from "@langchain/openai";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import { MULTI_PROVIDER_CONFIG_DIR } from "../test-fixtures/index.js";
import { buildModel, ModelFactory, type Candidate } from "./factory.js";
import { HealthRegistry } from "./health.js";
import { isProviderFailure } from "./errors.js";
import { fallbackSpecs, resolveSpec, specId } from "./spec.js";

const env = { OPENAI_API_KEY: "test-openai", DEEPSEEK_API_KEY: "test-deepseek" };
// Fallback/health mechanics need several providers, so these tests use the
// multi-provider fixture, not the committed single-model config (ADR-007).
const configFor = (profile?: "openai" | "deepseek" | "hybrid") =>
  loadConfig({
    configDir: MULTI_PROVIDER_CONFIG_DIR,
    env: profile ? { LUMEN_PROFILE: profile } : {},
  }).models;

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe("resolveSpec", () => {
  it("resolves agent → role → hybrid profile", () => {
    const cfg = configFor();
    expect(resolveSpec(cfg, "crowdReactor")).toMatchObject({
      role: "fastest",
      provider: "openai",
      model: "gpt-5.4-nano",
      maxOutputTokens: 300,
    });
    expect(resolveSpec(cfg, "curriculumArchitect")).toMatchObject({
      role: "heavy",
      provider: "openai",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
  });

  it("lets agent overrides beat the role's temperature", () => {
    const spec = resolveSpec(configFor(), "cadetTalk");
    expect(spec).toMatchObject({ provider: "deepseek", thinking: "off", temperature: 0.9 });
    expect(resolveSpec(configFor(), "grader").temperature).toBe(0);
  });

  it("drops temperature when DeepSeek thinking is on", () => {
    const spec = resolveSpec(configFor(), "classDirector");
    expect(spec).toMatchObject({ provider: "deepseek", thinking: "on" });
    expect(spec.temperature).toBeUndefined();
  });

  it("follows the active profile", () => {
    expect(resolveSpec(configFor("deepseek"), "curriculumArchitect")).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      thinking: "on",
    });
    expect(resolveSpec(configFor("openai"), "cadetTalk")).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-luna",
      reasoningEffort: "none",
    });
  });
});

describe("fallbackSpecs", () => {
  it("keeps config order and excludes the primary", () => {
    const cfg = configFor();
    const primary = resolveSpec(cfg, "cadetTalk"); // fast: deepseek-flash
    expect(fallbackSpecs(cfg, primary).map(specId)).toEqual([
      "openai:gpt-5.6-luna",
      "openai:gpt-5.4-nano",
    ]);
  });

  it("fills provider-specific params when crossing providers", () => {
    const cfg = configFor();
    const [luna] = fallbackSpecs(cfg, resolveSpec(cfg, "cadetTalk"));
    expect(luna).toMatchObject({ reasoningEffort: "none", temperature: 0.9, isFallback: true });
    expect(luna?.thinking).toBeUndefined();

    const [flash] = fallbackSpecs(cfg, resolveSpec(cfg, "crowdReactor")); // fastest: nano → flash
    expect(flash).toMatchObject({ provider: "deepseek", thinking: "off", maxOutputTokens: 300 });
    expect(flash?.reasoningEffort).toBeUndefined();
  });

  it("keeps heavy-role DeepSeek fallbacks thinking (tool loops work with it, ADR-004)", () => {
    const cfg = configFor();
    const primary = resolveSpec(cfg, "examiner");
    expect(fallbackSpecs(cfg, primary).find((s) => s.provider === "deepseek")?.thinking).toBe("on");
    expect(resolveSpec(cfg, "registrar").thinking).toBe("on");
  });
});

describe("HealthRegistry", () => {
  it("marks a provider unhealthy for 60s after 2 consecutive failures", () => {
    let t = 0;
    const h = new HealthRegistry({ now: () => t });
    expect(h.recordFailure("deepseek")).toBe(false);
    expect(h.isHealthy("deepseek")).toBe(true);
    expect(h.recordFailure("deepseek")).toBe(true);
    expect(h.isHealthy("deepseek")).toBe(false);
    t = 59_999;
    expect(h.isHealthy("deepseek")).toBe(false);
    t = 60_000;
    expect(h.isHealthy("deepseek")).toBe(true);
  });

  it("resets the count on success", () => {
    const h = new HealthRegistry();
    h.recordFailure("openai");
    h.recordSuccess("openai");
    h.recordFailure("openai");
    expect(h.isHealthy("openai")).toBe(true);
  });
});

describe("isProviderFailure", () => {
  it("classifies errors", () => {
    expect(isProviderFailure(httpError(500))).toBe(true);
    expect(isProviderFailure(httpError(429))).toBe(true);
    expect(isProviderFailure(httpError(400))).toBe(false);
    expect(isProviderFailure(httpError(401))).toBe(false);
    expect(isProviderFailure(new Error("Request timed out."))).toBe(true);
    expect(isProviderFailure(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isProviderFailure(abort)).toBe(false);
    expect(isProviderFailure("nope")).toBe(false);
  });
});

describe("ModelFactory.run", () => {
  let factory: ModelFactory;
  let health: HealthRegistry;
  const fake = (spec: { model: string }) => ({ fakeId: spec.model }) as unknown as BaseChatModel;
  const id = (c: Candidate) => specId(c.spec);

  beforeEach(() => {
    health = new HealthRegistry();
    factory = new ModelFactory({ config: configFor(), env, health, build: fake });
  });

  it("returns the primary's result when it succeeds", async () => {
    const tried: string[] = [];
    const out = await factory.run("cadetTalk", async (c) => {
      tried.push(id(c));
      return "ok";
    });
    expect(out).toBe("ok");
    expect(tried).toEqual(["deepseek:deepseek-flash"]);
  });

  it("falls back in order on provider failures", async () => {
    const tried: string[] = [];
    const out = await factory.run("cadetTalk", async (c) => {
      tried.push(id(c));
      if (c.spec.provider === "deepseek") throw httpError(503);
      if (c.spec.model === "gpt-5.6-luna") throw new Error("Request timed out.");
      return c.spec.model;
    });
    expect(out).toBe("gpt-5.4-nano");
    expect(tried).toEqual([
      "deepseek:deepseek-flash",
      "openai:gpt-5.6-luna",
      "openai:gpt-5.4-nano",
    ]);
  });

  it("rethrows non-provider errors without falling back", async () => {
    const tried: string[] = [];
    await expect(
      factory.run("cadetTalk", async (c) => {
        tried.push(id(c));
        throw httpError(400);
      }),
    ).rejects.toThrow("HTTP 400");
    expect(tried).toHaveLength(1);
    expect(health.isHealthy("deepseek")).toBe(true);
  });

  it("tries unhealthy providers last", async () => {
    health.recordFailure("deepseek");
    health.recordFailure("deepseek");
    expect(factory.candidates("cadetTalk").map(id)).toEqual([
      "openai:gpt-5.6-luna",
      "openai:gpt-5.4-nano",
      "deepseek:deepseek-flash",
    ]);
  });

  it("throws an AggregateError with every failure when all candidates fail", async () => {
    const err = await factory
      .run("cadetTalk", async () => {
        throw httpError(502);
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toHaveLength(3);
  });

  it("reports each attempt", async () => {
    const events: Array<{ id: string; ok: boolean }> = [];
    await factory.run(
      "crowdReactor",
      async (c) => {
        if (c.spec.provider === "openai") throw httpError(500);
        return 1;
      },
      { onAttempt: (e) => events.push({ id: specId(e.spec), ok: e.ok }) },
    );
    expect(events).toEqual([
      { id: "openai:gpt-5.4-nano", ok: false },
      { id: "deepseek:deepseek-flash", ok: true },
    ]);
  });
});

describe("buildModel", () => {
  const cfg = configFor();

  it("builds ChatOpenAI with reasoning effort and capped retries", () => {
    const model = buildModel(resolveSpec(cfg, "examiner"), { config: cfg, env });
    expect(model).toBeInstanceOf(ChatOpenAI);
    const m = model as ChatOpenAI;
    expect(m.model).toBe("gpt-5.6-terra");
    expect(m.reasoning).toEqual({ effort: "medium" });
    expect((m.caller as unknown as { maxRetries: number }).maxRetries).toBe(1);
  });

  it("builds ChatDeepSeek with an explicit thinking flag", () => {
    const off = buildModel(resolveSpec(cfg, "cadetTalk"), { config: cfg, env }) as ChatDeepSeek;
    expect(off).toBeInstanceOf(ChatDeepSeek);
    expect(off.modelKwargs).toEqual({ thinking: { type: "disabled" } });
    expect(off.temperature).toBe(0.9);
    const on = buildModel(resolveSpec(cfg, "classDirector"), { config: cfg, env }) as ChatDeepSeek;
    expect(on.modelKwargs).toEqual({ thinking: { type: "enabled" } });
  });

  it("fails clearly when the API key is missing", () => {
    expect(() => buildModel(resolveSpec(cfg, "examiner"), { config: cfg, env: {} })).toThrow(
      /OPENAI_API_KEY is not set/,
    );
  });
});

describe("ModelFactory + budget guard", () => {
  const fake = (spec: { model: string }) => ({ fakeId: spec.model }) as unknown as BaseChatModel;
  const meterIn = (state: string) => ({
    record: () => {},
    budgetState: () => state,
    assertCanCall: () => {
      if (state === "pause") throw new Error("paused");
    },
  });

  it("degrades every agent to the fastest role", () => {
    const f = new ModelFactory({
      config: configFor(),
      env,
      build: fake,
      meter: meterIn("degrade"),
    });
    expect(f.getModel("curriculumArchitect").spec).toMatchObject({
      role: "fastest",
      model: "gpt-5.4-nano",
    });
  });

  it("refuses to run when paused", async () => {
    const f = new ModelFactory({ config: configFor(), env, build: fake, meter: meterIn("pause") });
    await expect(f.run("cadetTalk", async () => 1)).rejects.toThrow("paused");
    expect(() => f.getModel("cadetTalk")).toThrow("paused");
  });

  it("attaches the usage callback to built models", () => {
    const cfg = configFor();
    const model = buildModel(resolveSpec(cfg, "examiner"), {
      config: cfg,
      env,
      meter: meterIn("ok"),
    });
    expect(model.callbacks).toHaveLength(1);
  });
});

describe("committed config (ADR-007: DeepSeek Flash only)", () => {
  const committed = loadConfig({ env: {} }).models;

  it("routes every agent to deepseek-flash with no cross-provider fallback", () => {
    for (const agent of Object.keys(committed.agents) as Array<keyof typeof committed.agents>) {
      const spec = resolveSpec(committed, agent);
      expect(specId(spec), agent).toBe("deepseek:deepseek-flash");
      expect(fallbackSpecs(committed, spec), agent).toEqual([]);
    }
  });

  it("differentiates roles by thinking and effort", () => {
    expect(resolveSpec(committed, "crowdReactor")).toMatchObject({ thinking: "off" });
    // Spike M1-S1 moved the Director to thinking off (ADR-002).
    expect(resolveSpec(committed, "classDirector")).toMatchObject({
      role: "fast",
      thinking: "off",
    });
    expect(resolveSpec(committed, "cadetHomework")).toMatchObject({
      thinking: "on",
      reasoningEffort: "low",
    });
    expect(resolveSpec(committed, "grader")).toMatchObject({
      thinking: "on",
      reasoningEffort: "high",
    });
  });

  it("sends reasoning_effort in the DeepSeek body only when thinking", () => {
    const heavy = buildModel(resolveSpec(committed, "examiner"), {
      config: committed,
      env,
    }) as ChatDeepSeek;
    expect(heavy.modelKwargs).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });
    const fast = buildModel(resolveSpec(committed, "cadetTalk"), {
      config: committed,
      env,
    }) as ChatDeepSeek;
    expect(fast.modelKwargs).toEqual({ thinking: { type: "disabled" } });
  });
});
