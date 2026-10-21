import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import { recall, reinforce, retention } from "./memory.js";

const mem = loadConfig({ env: {} }).game.memory;
const day = (n: number) => new Date(Date.parse("2026-10-01T09:00:00Z") + n * 86_400_000);
const at = day(0).toISOString();

describe("forgetting (V2-01)", () => {
  it("halves the forgettable part after one half-life, and never drops below the floor", () => {
    expect(recall(0.8, at, 2, day(0), mem)).toBeCloseTo(0.8);
    // floor 0.35: after one half-life 0.35 + 0.65 × 0.5 = 0.675 of the strength.
    expect(recall(0.8, at, 2, day(2), mem)).toBeCloseTo(0.8 * 0.675);
    expect(recall(0.8, at, 2, day(400), mem)).toBeCloseTo(0.8 * 0.35, 3);
    expect(retention(at, 2, day(2), mem)).toBeCloseTo(0.675);
  });

  it("a concept never taught has nothing to forget", () => {
    expect(recall(0, null, null, day(9), mem)).toBe(0);
    expect(recall(0.5, null, null, day(9), mem)).toBe(0.5);
  });

  it("a spaced review starts from what's left and lasts longer; cramming doesn't", () => {
    const row = { comprehension: 0.8, lastTaughtAt: at, stabilityDays: 2 };
    const spaced = reinforce(row, day(3), mem);
    expect(spaced.base).toBeCloseTo(recall(0.8, at, 2, day(3), mem));
    expect(spaced.stabilityDays).toBeCloseTo(2 * mem.growth);
    const crammed = reinforce(row, new Date(Date.parse(at) + 3_600_000), mem);
    expect(crammed.stabilityDays).toBe(2);
  });

  it("caps the half-life", () => {
    let s = 2;
    for (let i = 0; i < 20; i++)
      s = reinforce(
        { comprehension: 0.9, lastTaughtAt: at, stabilityDays: s },
        day(30),
        mem,
      ).stabilityDays;
    expect(s).toBe(mem.maxHalfLifeDays);
  });
});
