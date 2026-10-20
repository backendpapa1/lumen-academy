import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import { cohortArchetypes, planCohort, triangularInt } from "./registration.js";
import { rng } from "./rng.js";

const game = loadConfig({ env: {} }).game;

describe("triangularInt", () => {
  it("stays in [4, 15] and peaks near the mode", () => {
    const r = rng(1);
    const counts = new Map<number, number>();
    let sum = 0;
    for (let i = 0; i < 20000; i++) {
      const n = triangularInt(r, 4, 9, 15);
      counts.set(n, (counts.get(n) ?? 0) + 1);
      sum += n;
    }
    expect(Math.min(...counts.keys())).toBe(4);
    expect(Math.max(...counts.keys())).toBe(15);
    const mostCommon = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    expect(Math.abs(mostCommon - 9)).toBeLessThanOrEqual(1);
    expect(sum / 20000).toBeCloseTo((4 + 9 + 15) / 3, 0);
    expect(counts.get(15)! + counts.get(4)!).toBeLessThan(counts.get(9)!);
  });
});

describe("cohortArchetypes", () => {
  it("always includes the guaranteed archetypes for the size", () => {
    for (let size = 4; size <= 15; size++) {
      const a = cohortArchetypes(size, "standard", game, rng(size));
      expect(a).toHaveLength(size);
      for (const must of ["skeptic", "lost_signal", "literalist"]) expect(a).toContain(must);
      if (size >= 6) expect(a).toContain("overachiever");
      if (size >= 8) expect(a).toContain("pragmatist");
    }
  });

  it("shifts the mix by difficulty, and only adds saboteurs when unlocked", () => {
    const count = (difficulty: "gentle" | "ruthless", arch: string, unlocked = false) => {
      let n = 0;
      for (let s = 0; s < 400; s++)
        n += cohortArchetypes(15, difficulty, game, rng(s), { saboteurUnlocked: unlocked }).filter(
          (x) => x === arch,
        ).length;
      return n;
    };
    expect(count("ruthless", "skeptic")).toBeGreaterThan(count("gentle", "skeptic") * 2);
    expect(count("gentle", "quiet")).toBeGreaterThan(count("ruthless", "quiet") * 2);
    expect(count("ruthless", "saboteur")).toBe(0);
    expect(count("ruthless", "saboteur", true)).toBeGreaterThan(0);
  });
});

describe("planCohort", () => {
  it("is reproducible from the seed and varies across seeds", () => {
    expect(planCohort(42, "standard", game)).toEqual(planCohort(42, "standard", game));
    expect(planCohort(42, "standard", game)).not.toEqual(planCohort(43, "standard", game));
  });

  it("gives distinct seats, bounded traits near the archetype means, and diverse appearance hints", () => {
    const all = Array.from({ length: 50 }, (_, s) => planCohort(s, "standard", game)).flat();
    for (const plan of Array.from({ length: 50 }, (_, s) => planCohort(s, "standard", game))) {
      expect(new Set(plan.map((c) => c.seat)).size).toBe(plan.length);
      for (const c of plan) {
        expect(c.seat).toBeGreaterThanOrEqual(0);
        expect(c.seat).toBeLessThan(15);
      }
    }
    for (const c of all) {
      for (const v of Object.values(c.traits)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(
        Math.abs(c.traits.attention - game.archetypes[c.archetype].attention),
      ).toBeLessThanOrEqual(game.traitSpread + 0.01);
    }
    expect(new Set(all.map((c) => c.appearance.heritageHint)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(all.map((c) => c.homeworld)).size).toBeGreaterThanOrEqual(6);
  });

  it("honours a fixed size (transfer students, tests)", () => {
    expect(planCohort(1, "gentle", game, { size: 4 })).toHaveLength(4);
  });
});
