import { describe, expect, it } from "vitest";
import type { PricingConfig } from "@lumen/shared";
import { estimateUsd, peakMultiplier } from "./pricing.js";

const pricing: PricingConfig = {
  openai: {
    models: {
      "gpt-5.4-nano": { input: 0.1, cachedInput: 0.01, output: 0.4 },
      "gpt-5.6-terra": { input: null, cachedInput: null, output: null },
      "nocache-model": { input: 1, cachedInput: null, output: 2 },
      "gpt-image-2": { perImage: { low: 0.01, medium: 0.04, high: null } },
    },
  },
  deepseek: {
    models: { "deepseek-flash": { input: 0.2, cachedInput: 0.02, output: 0.8 } },
    timeOfDay: {
      tz: "Asia/Shanghai",
      peak: [
        ["09:00", "12:00"],
        ["14:00", "18:00"],
      ],
      weekdaysOnly: true,
      peakMultiplier: 2,
    },
  },
};

// 10:00 Beijing = 02:00 UTC (peak); 20:00 Beijing = 12:00 UTC (off-peak).
const PEAK = new Date("2026-10-20T02:00:00Z");
const OFF_PEAK = new Date("2026-10-20T12:00:00Z");

describe("estimateUsd", () => {
  it("prices input, cached input and output per 1M tokens", () => {
    const usd = estimateUsd(pricing, {
      provider: "openai",
      model: "gpt-5.4-nano",
      inputTokens: 1_000_000,
      cachedTokens: 400_000,
      outputTokens: 500_000,
      at: OFF_PEAK,
    });
    // 600k × 0.1 + 400k × 0.01 + 500k × 0.4, per 1M
    expect(usd).toBeCloseTo(0.06 + 0.004 + 0.2, 10);
  });

  it("returns null when a needed price is unknown", () => {
    expect(
      estimateUsd(pricing, {
        provider: "openai",
        model: "gpt-5.6-terra",
        inputTokens: 10,
        at: OFF_PEAK,
      }),
    ).toBeNull();
    expect(
      estimateUsd(pricing, {
        provider: "openai",
        model: "unlisted",
        inputTokens: 10,
        at: OFF_PEAK,
      }),
    ).toBeNull();
    expect(
      estimateUsd(pricing, {
        provider: "openai",
        model: "gpt-image-2",
        images: 1,
        imageQuality: "high",
        at: OFF_PEAK,
      }),
    ).toBeNull();
  });

  it("charges cached tokens at the full input rate when cachedInput is unknown", () => {
    const usd = estimateUsd(pricing, {
      provider: "openai",
      model: "nocache-model",
      inputTokens: 1_000_000,
      cachedTokens: 1_000_000,
      at: OFF_PEAK,
    });
    expect(usd).toBeCloseTo(1, 10);
  });

  it("prices images by quality", () => {
    expect(
      estimateUsd(pricing, {
        provider: "openai",
        model: "gpt-image-2",
        images: 3,
        imageQuality: "medium",
        at: OFF_PEAK,
      }),
    ).toBeCloseTo(0.12, 10);
  });

  it("applies the DeepSeek peak multiplier in Beijing peak hours only", () => {
    const call = {
      provider: "deepseek" as const,
      model: "deepseek-flash",
      inputTokens: 1_000_000,
    };
    expect(estimateUsd(pricing, { ...call, at: OFF_PEAK })).toBeCloseTo(0.2, 10);
    expect(estimateUsd(pricing, { ...call, at: PEAK })).toBeCloseTo(0.4, 10);
  });
});

describe("peakMultiplier", () => {
  const tod = pricing.deepseek.timeOfDay;
  it("treats window ends as exclusive", () => {
    expect(peakMultiplier(tod, new Date("2026-10-20T01:00:00Z"))).toBe(2); // 09:00 Beijing
    expect(peakMultiplier(tod, new Date("2026-10-20T03:59:00Z"))).toBe(2); // 11:59
    expect(peakMultiplier(tod, new Date("2026-10-20T04:00:00Z"))).toBe(1); // 12:00
    expect(peakMultiplier(undefined, PEAK)).toBe(1);
  });

  it("is off-peak all weekend when weekdaysOnly (Beijing calendar)", () => {
    expect(new Date("2026-10-20T02:00:00Z").getUTCDay()).toBe(2); // Tuesday
    expect(peakMultiplier(tod, new Date("2026-10-24T02:00:00Z"))).toBe(1); // Sat 10:00 Beijing
    expect(peakMultiplier(tod, new Date("2026-10-25T07:00:00Z"))).toBe(1); // Sun 15:00 Beijing
    expect(peakMultiplier(tod, new Date("2026-10-23T07:00:00Z"))).toBe(2); // Fri 15:00 Beijing
    // Sunday 23:00 UTC is already Monday 07:00 in Beijing: weekday, but before the window.
    expect(peakMultiplier(tod, new Date("2026-10-25T23:00:00Z"))).toBe(1);
    expect(peakMultiplier(tod, new Date("2026-10-26T01:30:00Z"))).toBe(2); // Mon 09:30 Beijing
  });
});
