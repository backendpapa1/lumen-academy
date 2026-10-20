import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import {
  adoptsMisconception,
  applyDelta,
  comprehensionDelta,
  fatigue,
  learningStyleMatch,
  type ComprehensionConfig,
} from "./comprehension.js";

const game = loadConfig({ env: {} }).game;
const cfg: ComprehensionConfig = { comprehension: game.comprehension, fatigue: game.fatigue };
const cadet = { attention: 0.6, skepticism: 0.5, learningStyle: "formal" as const };
const clear = { clarity: 0.85, accuracy: 1 };
const plain = "The root goes in the block header.";

describe("learningStyleMatch", () => {
  it("detects style cues", () => {
    expect(learningStyleMatch("analogy", "Think of it like a tournament bracket.")).toBe(true);
    expect(learningStyleMatch("example-first", "For example, four transactions.")).toBe(true);
    expect(learningStyleMatch("formal", plain)).toBe(false);
  });
});

describe("fatigue", () => {
  it("is flat until onset, then declines to the floor", () => {
    expect(fatigue(5, game.fatigue)).toBe(1);
    expect(fatigue(game.fatigue.onsetMinute + 5, game.fatigue)).toBeCloseTo(
      1 - 5 * game.fatigue.perMinute,
    );
    expect(fatigue(500, game.fatigue)).toBe(game.fatigue.floor);
  });
});

describe("comprehensionDelta", () => {
  it("is base × clarity × accuracy × attention without a style match or proposal", () => {
    const d = comprehensionDelta({ teaching: clear, cadet, message: plain, periodMinute: 0 }, cfg);
    expect(d.delta).toBeCloseTo(game.comprehension.base * 0.85 * 1 * 0.6);
    expect(d.style).toBe(0);
    expect(d.directorAdjust).toBe(0);
  });

  it("adds the style bonus when the message fits the cadet", () => {
    const d = comprehensionDelta(
      {
        teaching: clear,
        cadet,
        message: "Formally, it is defined as the top hash.",
        periodMinute: 0,
      },
      cfg,
    );
    expect(d.style).toBe(game.comprehension.styleBonus);
  });

  it("bounds the Director's nudge", () => {
    const up = comprehensionDelta(
      { teaching: clear, cadet, message: plain, periodMinute: 0, proposedDelta: 0.4 },
      cfg,
    );
    expect(up.directorAdjust).toBeCloseTo(game.comprehension.directorAdjustBound);
    const down = comprehensionDelta(
      { teaching: clear, cadet, message: plain, periodMinute: 0, proposedDelta: -0.3 },
      cfg,
    );
    expect(down.directorAdjust).toBeCloseTo(-game.comprehension.directorAdjustBound);
    const small = comprehensionDelta(
      { teaching: clear, cadet, message: plain, periodMinute: 0, proposedDelta: 0.12 },
      cfg,
    );
    expect(small.delta).toBeCloseTo(0.12); // within the bound, the Director's value wins
  });

  it("clamps to [deltaMin, deltaMax] and halves low-confidence turns", () => {
    const strong = comprehensionDelta(
      {
        teaching: { clarity: 1, accuracy: 1 },
        cadet: { ...cadet, attention: 1 },
        message: plain,
        periodMinute: 0,
        proposedDelta: 1,
      },
      cfg,
    );
    expect(strong.delta).toBeLessThanOrEqual(game.comprehension.deltaMax);
    const normal = comprehensionDelta(
      { teaching: clear, cadet, message: plain, periodMinute: 0 },
      cfg,
    );
    const low = comprehensionDelta(
      { teaching: clear, cadet, message: plain, periodMinute: 0, lowConfidence: true },
      cfg,
    );
    expect(low.delta).toBeCloseTo(normal.delta * game.comprehension.lowConfidenceWeight);
  });

  it("gives less for wrong teaching than clear teaching (the mirror)", () => {
    const right = comprehensionDelta(
      { teaching: clear, cadet, message: plain, periodMinute: 0 },
      cfg,
    ).delta;
    const wrong = comprehensionDelta(
      { teaching: { clarity: 0.85, accuracy: 0.3 }, cadet, message: plain, periodMinute: 0 },
      cfg,
    ).delta;
    expect(wrong).toBeLessThan(right / 2);
  });
});

describe("applyDelta", () => {
  it("keeps comprehension in [0, 1]", () => {
    expect(applyDelta(0.9, 0.4)).toBe(1);
    expect(applyDelta(0.1, -0.3)).toBe(0);
  });
});

describe("adoptsMisconception", () => {
  it("is deterministic per seed and follows (1 − skepticism) × k", () => {
    const seed = { turnId: "trn_1", cadetId: "cdt_1", claim: "root in every tx" };
    expect(adoptsMisconception(0.3, cfg, seed)).toBe(adoptsMisconception(0.3, cfg, seed));
    expect(adoptsMisconception(1, cfg, seed)).toBe(false);
    let adopted = 0;
    for (let i = 0; i < 2000; i++)
      if (adoptsMisconception(0.5, cfg, { ...seed, cadetId: `c${i}` })) adopted++;
    expect(adopted / 2000).toBeCloseTo(0.5 * game.comprehension.misconceptionAdoption, 1);
  });
});
