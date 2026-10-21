import type { PricingConfig, Provider } from "@lumen/shared";

export interface CostInput {
  provider: Provider;
  model: string;
  inputTokens?: number;
  /** Subset of inputTokens served from the provider's prompt cache. */
  cachedTokens?: number;
  outputTokens?: number;
  images?: number;
  imageQuality?: "low" | "medium" | "high";
  at: Date;
}

const PER_MILLION = 1_000_000;

/**
 * Estimated USD for one call, or null when pricing.yaml lacks a price we need
 * (the meter shows "≈?"). Missing cachedInput prices are charged at the full
 * input rate: overestimating is safer for the budget cap.
 */
export function estimateUsd(pricing: PricingConfig, c: CostInput): number | null {
  const providerPricing = pricing[c.provider];
  const price = providerPricing?.models[c.model];
  if (!price) return null;

  let usd: number;
  if ("perImage" in price) {
    if (!c.images) return 0;
    const each = price.perImage[c.imageQuality ?? "medium"];
    if (each == null) return null;
    usd = each * c.images;
  } else {
    const input = c.inputTokens ?? 0;
    const cached = Math.min(c.cachedTokens ?? 0, input);
    const output = c.outputTokens ?? 0;
    if (input > 0 && price.input == null) return null;
    if (output > 0 && price.output == null) return null;
    const inputRate = price.input ?? 0;
    const cachedRate = price.cachedInput ?? inputRate;
    usd =
      ((input - cached) * inputRate + cached * cachedRate + output * (price.output ?? 0)) /
      PER_MILLION;
  }
  return usd * peakMultiplier(providerPricing.timeOfDay, c.at);
}

/** DeepSeek charges more during Beijing weekday peak windows (docs/04 §5). */
export function peakMultiplier(
  tod: PricingConfig["deepseek"]["timeOfDay"] | undefined,
  at: Date,
): number {
  if (!tod) return 1;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tod.tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  if (tod.weekdaysOnly && (weekday === "Sat" || weekday === "Sun")) return 1;
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  const local = `${hh}:${mm}`;
  const inPeak = tod.peak.some(([start, end]) => local >= start && local < end);
  return inPeak ? tod.peakMultiplier : 1;
}
