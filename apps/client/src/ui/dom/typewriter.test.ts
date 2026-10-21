import { describe, expect, it } from "vitest";
import { lingerMs, revealStep } from "./typewriter";

describe("revealStep", () => {
  it("types at ~45 chars/s when the stream is slow", () => {
    expect(revealStep(0, 20, 0.1, false)).toBeCloseTo(4.5);
  });
  it("speeds up so it never lags the stream by much", () => {
    // 300 chars waiting: 200 c/s, not 45.
    expect(revealStep(0, 300, 0.1, false)).toBeCloseTo(20);
  });
  it("finishes quickly once the stream is done", () => {
    let shown = 0;
    for (let t = 0; t < 0.7; t += 1 / 60) shown = revealStep(shown, 120, 1 / 60, true);
    expect(shown).toBe(120);
  });
  it("never overshoots or goes backwards", () => {
    expect(revealStep(10, 12, 1, false)).toBe(12);
    expect(revealStep(30, 12, 0.1, false)).toBe(12); // text was replaced by a shorter rewrite
  });
});

describe("lingerMs", () => {
  it("is bounded reading time", () => {
    expect(lingerMs("ok")).toBe(5_000);
    expect(lingerMs("x".repeat(1000))).toBe(14_000);
  });
});
