import { afterEach, describe, expect, it } from "vitest";
import type { TeachingAnalysis } from "@lumen/shared";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { smallWorld } from "../test-fixtures/world.js";
import { awardStickers, recentStickers } from "./stickers.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());

const analysis = (over: Partial<TeachingAnalysis["teaching"]> = {}): TeachingAnalysis => ({
  conceptIds: [],
  teaching: { accuracy: 0.9, clarity: 0.9, coverage: [], errors: [], ...over },
  ledgerDeltas: [],
});

describe("stickers (V4-06)", () => {
  it("rules: analogy, fixed confusion, a landed interest; once per kind, capped per period", async () => {
    const w = await smallWorld([
      { attention: 0.5, skepticism: 0.5 },
      { attention: 0.5, skepticism: 0.5 },
    ]);
    h = w.handle;
    const [a, b] = [w.cadets[0]!.id, w.cadets[1]!.id];
    const students = [
      { id: a, archetype: "skeptic", interests: ["football"] },
      { id: b, archetype: "quiet", interests: ["baking"] },
    ];
    const base = { periodId: "per_1", classroomId: w.classroomId, students };
    const change = (cadetId: string, delta: number, resolved: string[] = []) => ({
      cadetId,
      conceptId: w.conceptIds[0]!,
      comprehension: 0.5,
      delta,
      adopted: [],
      resolved,
    });

    const first = awardStickers(h, cfg.game, {
      ...base,
      text: "It's like a football league table: every result changes the standings.",
      analysis: analysis(),
      changes: [change(a, 0.05), change(b, 0.2, ["roots are in every transaction"])],
    });
    expect(first.map((s) => [s.kind, s.cadetId])).toEqual([
      ["fixed_confusion", b],
      ["landed", a],
      ["best_analogy", b],
    ]);
    // The cap (3) is reached: nothing more this period.
    expect(
      awardStickers(h, cfg.game, {
        ...base,
        text: "I was wrong earlier, let me correct that.",
        analysis: analysis(),
        changes: [],
      }),
    ).toEqual([]);
    expect(recentStickers(h, w.classroomId)).toHaveLength(3);
  });

  it("no sticker for a muddled or wrong explanation", async () => {
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    h = w.handle;
    const out = awardStickers(h, cfg.game, {
      periodId: "per_2",
      classroomId: w.classroomId,
      students: [{ id: w.cadets[0]!.id, archetype: "skeptic", interests: [] }],
      text: "Imagine a tree, sort of, I think the root is in every transaction.",
      analysis: analysis({
        accuracy: 0.2,
        errors: [{ claim: "x", correction: "y", citation: "kf1" }],
      }),
      changes: [],
    });
    expect(out).toEqual([]);
  });
});
