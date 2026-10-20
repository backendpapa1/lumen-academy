import type { GameConfig, LearningStyle } from "@lumen/shared";
import { rng, seedFrom } from "./rng.js";

// The mirror (docs/03 §4.3): the server, not the LLM, computes how much each
// cadet's comprehension moves, so the game stays tunable and deterministic.

export type ComprehensionConfig = Pick<GameConfig, "comprehension" | "fatigue">;

export interface TeachingQuality {
  accuracy: number; // 0..1
  clarity: number; // 0..1
}

export interface CadetTraits {
  attention: number;
  skepticism: number;
  learningStyle: LearningStyle;
}

const STYLE_CUES: Record<LearningStyle, RegExp> = {
  "example-first": /\b(for example|for instance|e\.g\.|say you|suppose|let's say)\b/i,
  analogy: /\b(it's like|is like|think of|like a|imagine it as|similar to|bracket|just as)\b/i,
  formal: /\b(defined as|by definition|formally|in other words|precisely|=)\b/i,
  visual: /\b(picture|imagine|diagram|draw|visuali[sz]e|tree|layer|level)\b/i,
};

/** Cheap, deterministic check: does the message speak in this cadet's style? */
export function learningStyleMatch(style: LearningStyle, message: string): boolean {
  return STYLE_CUES[style].test(message);
}

/** Attention multiplier: 1.0 until onset, then declines per minute to a floor. */
export function fatigue(periodMinute: number, cfg: ComprehensionConfig["fatigue"]): number {
  if (periodMinute <= cfg.onsetMinute) return 1;
  return Math.max(cfg.floor, 1 - (periodMinute - cfg.onsetMinute) * cfg.perMinute);
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export interface DeltaInput {
  teaching: TeachingQuality;
  cadet: CadetTraits;
  message: string;
  periodMinute: number;
  /** The Director's proposed delta for this cadet, if it listed one. */
  proposedDelta?: number;
  /** The Director call fell back to a weaker path (ADR-006 D3). */
  lowConfidence?: boolean;
}

export interface DeltaBreakdown {
  base: number;
  style: number;
  attention: number;
  directorAdjust: number;
  delta: number;
}

/**
 * delta = clamp(base × attention + style + directorAdjust, deltaMin, deltaMax)
 * directorAdjust nudges toward the Director's proposal, bounded (ADR-006 D4).
 */
export function comprehensionDelta(input: DeltaInput, cfg: ComprehensionConfig): DeltaBreakdown {
  const c = cfg.comprehension;
  const base = c.base * input.teaching.clarity * input.teaching.accuracy;
  const style = learningStyleMatch(input.cadet.learningStyle, input.message) ? c.styleBonus : 0;
  const attention = input.cadet.attention * fatigue(input.periodMinute, cfg.fatigue);
  const formula = base * attention + style;
  const directorAdjust =
    input.proposedDelta === undefined
      ? 0
      : clamp(input.proposedDelta - formula, -c.directorAdjustBound, c.directorAdjustBound);
  let delta = clamp(formula + directorAdjust, c.deltaMin, c.deltaMax);
  if (input.lowConfidence) delta *= c.lowConfidenceWeight;
  return { base, style, attention, directorAdjust, delta };
}

export function applyDelta(comprehension: number, delta: number): number {
  return clamp(comprehension + delta, 0, 1);
}

/** Seeded draw: does this cadet absorb the teacher's error? p = (1 − skepticism) × k. */
export function adoptsMisconception(
  skepticism: number,
  cfg: ComprehensionConfig,
  seed: { turnId: string; cadetId: string; claim: string },
): boolean {
  const p = (1 - skepticism) * cfg.comprehension.misconceptionAdoption;
  return rng(seedFrom(seed.turnId, seed.cadetId, seed.claim))() < p;
}
