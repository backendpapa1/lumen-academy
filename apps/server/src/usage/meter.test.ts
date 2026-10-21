import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelsConfig, PricingConfig } from "@lumen/shared";
import { openDb, runMigrations, type DbHandle } from "../db/client.js";
import { usageLog } from "../db/schema.js";
import { BudgetPausedError, UsageMeter, withUsageContext, type BudgetState } from "./meter.js";

// $1 per 1M input tokens makes the arithmetic readable.
const pricing: PricingConfig = {
  openai: { models: { m: { input: 1, cachedInput: 1, output: 1 }, unpriced: { input: null } } },
  deepseek: { models: {} },
};
const budget: ModelsConfig["budget"] = {
  monthlyUsdCap: 10,
  softWarnAt: 0.8,
  degradeAt: 0.95,
  onCap: "degrade_then_pause",
  imagesUsdCap: 1,
};
const spend = (usd: number) => ({
  agent: "cadetTalk",
  provider: "openai" as const,
  model: "m",
  inputTokens: usd * 1_000_000,
});

describe("UsageMeter", () => {
  let h: DbHandle;
  let clock: Date;
  let meter: UsageMeter;

  beforeEach(() => {
    h = openDb(":memory:");
    runMigrations(h);
    clock = new Date(2026, 9, 20, 21, 0); // local time
    meter = new UsageMeter({ db: h.db, pricing, budget, now: () => clock });
  });
  afterEach(() => h.close());

  it("writes every call to usage_log with its estimate", () => {
    const { estUsd } = meter.record({
      ...spend(0.5),
      outputTokens: 0,
      latencyMs: 812.4,
      fallbackUsed: true,
    });
    expect(estUsd).toBeCloseTo(0.5);
    const rows = h.db.select().from(usageLog).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: "cadetTalk",
      model: "m",
      latencyMs: 812,
      fallbackUsed: true,
    });
  });

  it("logs unpriced calls with a null estimate and counts them", () => {
    const { estUsd } = meter.record({
      agent: "examiner",
      provider: "openai",
      model: "unpriced",
      inputTokens: 5,
    });
    expect(estUsd).toBeNull();
    expect(meter.totals().unpricedCalls).toBe(1);
    expect(meter.totals().monthUsd).toBe(0);
  });

  it("walks ok → warn → degrade → pause and notifies on each change", () => {
    const seen: BudgetState[] = [];
    meter.onStateChange((s) => seen.push(s));
    expect(meter.record(spend(7.9)).state).toBe("ok");
    expect(meter.record(spend(0.1)).state).toBe("warn"); // 8.0 = 80%
    expect(meter.record(spend(1.5)).state).toBe("degrade"); // 9.5 = 95%
    expect(() => meter.assertCanCall()).not.toThrow();
    expect(meter.record(spend(0.5)).state).toBe("pause"); // 10.0 = cap
    expect(() => meter.assertCanCall()).toThrow(BudgetPausedError);
    expect(seen).toEqual(["warn", "degrade", "pause"]);
  });

  it("skips degrade when onCap is pause", () => {
    const m = new UsageMeter({
      db: h.db,
      pricing,
      budget: { ...budget, onCap: "pause" },
      now: () => clock,
    });
    expect(m.record(spend(9.6)).state).toBe("warn");
    expect(m.record(spend(0.4)).state).toBe("pause");
  });

  it("resets at the start of a new month and restores spend from the DB on restart", () => {
    meter.record(spend(9));
    expect(meter.budgetState()).toBe("warn");

    const restarted = new UsageMeter({ db: h.db, pricing, budget, now: () => clock });
    expect(restarted.totals().monthUsd).toBeCloseTo(9);

    clock = new Date(2026, 10, 1, 0, 5);
    expect(restarted.budgetState()).toBe("ok");
    expect(restarted.totals().monthUsd).toBe(0);
  });

  it("totals per period, day and month", () => {
    withUsageContext({ periodId: "per_1" }, () => meter.record(spend(1)));
    meter.record({ ...spend(2), periodId: "per_2" });
    clock = new Date(2026, 9, 21, 9, 0); // next day
    withUsageContext({ periodId: "per_1" }, () => meter.record(spend(0.25)));

    const t = meter.totals("per_1");
    expect(t.periodUsd).toBeCloseTo(1.25);
    expect(t.dayUsd).toBeCloseTo(0.25);
    expect(t.monthUsd).toBeCloseTo(3.25);
    expect(t.capUsd).toBe(10);
    expect(meter.totals().periodUsd).toBeNull();
  });
});

describe("image budget", () => {
  it("counts only image spend against imagesUsdCap and refuses past it", async () => {
    const { openDb, runMigrations } = await import("../db/client.js");
    const h = openDb(":memory:");
    runMigrations(h);
    const pricing = {
      openai: { models: { "img-x": { perImage: { low: 0.4, medium: 0.4, high: 0.4 } } } },
      deepseek: { models: {} },
    } as unknown as ConstructorParameters<typeof UsageMeter>[0]["pricing"];
    const meter = new UsageMeter({ db: h.db, pricing, budget });
    meter.record({ agent: "classDirector", provider: "openai", model: "img-x", images: 1 }); // not an image agent
    expect(meter.imageMonthUsd()).toBe(0);
    meter.record({ agent: "image:portrait", provider: "openai", model: "img-x", images: 1 });
    meter.record({ agent: "image:emblem", provider: "openai", model: "img-x", images: 1 });
    expect(meter.imageMonthUsd()).toBeCloseTo(0.8);
    expect(meter.imageBudgetLeft()).toBeCloseTo(0.2);
    expect(() => meter.assertCanCallImage()).not.toThrow();
    meter.record({ agent: "image:portrait", provider: "openai", model: "img-x", images: 1 });
    expect(() => meter.assertCanCallImage()).toThrow(BudgetPausedError);
    expect(() => meter.assertCanCall()).not.toThrow(); // text agents carry on
    h.close();
  });
});
