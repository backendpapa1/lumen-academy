import type { TeachingAnalysis } from "@lumen/shared";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { ledgerEntries } from "../db/schema.js";
import { smallWorld } from "../test-fixtures/world.js";
import { applyTurnToLedger, type Misconception } from "./ledger.js";
import { conceptStatus, myMastery } from "./status.js";

const game = loadConfig({ env: {} }).game;
let h: DbHandle | undefined;
afterEach(() => h?.close());

const analysis = (
  conceptIds: string[],
  over: Partial<TeachingAnalysis["teaching"]> = {},
  deltas: TeachingAnalysis["ledgerDeltas"] = [],
): TeachingAnalysis => ({
  conceptIds,
  teaching: { accuracy: 1, clarity: 0.85, coverage: [], errors: [], ...over },
  ledgerDeltas: deltas,
});

describe("applyTurnToLedger", () => {
  it("creates entries, counts exposures, and gives attentive cadets more", async () => {
    const w = await smallWorld([
      { attention: 0.9, skepticism: 0.5 },
      { attention: 0.3, skepticism: 0.5 },
    ]);
    h = w.handle;
    const turn = (n: number) =>
      applyTurnToLedger(h!, game, {
        turnId: `t${n}`,
        message: "The root lives in the header.",
        periodMinute: n,
        analysis: analysis([w.conceptIds[0]!]),
        cadets: w.cadets,
      });
    turn(1);
    const changes = turn(2);
    const [keen, dreamy] = changes;
    expect(keen!.comprehension).toBeGreaterThan(dreamy!.comprehension * 2);
    const rows = h.db.select().from(ledgerEntries).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.exposures === 2 && r.lastTaughtAt)).toBe(true);
  });

  it("touches only the concepts the Director tagged, and nothing for off-topic chatter", async () => {
    const w = await smallWorld([{ attention: 0.6, skepticism: 0.5 }]);
    h = w.handle;
    expect(
      applyTurnToLedger(h, game, {
        turnId: "t",
        message: "hi",
        periodMinute: 0,
        analysis: analysis([]),
        cadets: w.cadets,
      }),
    ).toEqual([]);
    applyTurnToLedger(h, game, {
      turnId: "t2",
      message: "x",
      periodMinute: 0,
      analysis: analysis([w.conceptIds[1]!]),
      cadets: w.cadets,
    });
    expect(
      h.db
        .select()
        .from(ledgerEntries)
        .all()
        .map((r) => r.conceptId),
    ).toEqual([w.conceptIds[1]]);
  });

  it("spreads teacher errors to credulous cadets far more than to skeptics, then a correction resolves them", async () => {
    const credulous = Array.from({ length: 40 }, () => ({ attention: 0.6, skepticism: 0.05 }));
    const skeptics = Array.from({ length: 40 }, () => ({ attention: 0.6, skepticism: 0.95 }));
    const w = await smallWorld([...credulous, ...skeptics]);
    h = w.handle;
    const claim = "The Merkle root is stored in every transaction.";
    const changes = applyTurnToLedger(h, game, {
      turnId: "t1",
      message: claim,
      periodMinute: 1,
      analysis: analysis([w.conceptIds[0]!], {
        accuracy: 0.2,
        errors: [{ claim, correction: "header", citation: "kf2" }],
      }),
      cadets: w.cadets,
    });
    const adoptedBy = (from: number, to: number) =>
      changes.slice(from, to).filter((c) => c.adopted.length).length;
    expect(adoptedBy(0, 40)).toBeGreaterThan(adoptedBy(40, 80) * 3);

    const believer = changes.find((c) => c.adopted.length)!;
    const fix = applyTurnToLedger(h, game, {
      turnId: "t2",
      message: "Correction: the root is only in the header.",
      periodMinute: 2,
      analysis: analysis([w.conceptIds[0]!], {}, [
        {
          cadetId: believer.cadetId,
          conceptId: w.conceptIds[0]!,
          comprehensionDelta: 0.2,
          resolvedMisconception: "the merkle root is stored in every transaction",
        },
      ]),
      cadets: w.cadets.filter((c) => c.id === believer.cadetId),
    });
    expect(fix[0]!.resolved).toHaveLength(1);
    const row = h.db
      .select()
      .from(ledgerEntries)
      .all()
      .find((r) => r.cadetId === believer.cadetId)!;
    expect(JSON.parse(row.misconceptionsJson) as Misconception[]).toEqual([]);
  });

  it("replaying the same turn on the same cadets gives the same outcome", async () => {
    const w = await smallWorld(
      Array.from({ length: 20 }, () => ({ attention: 0.6, skepticism: 0.4 })),
    );
    h = w.handle;
    const claim = "wrong";
    const run = () => {
      h!.db.delete(ledgerEntries).run();
      return applyTurnToLedger(h!, game, {
        turnId: "same",
        message: claim,
        periodMinute: 0,
        analysis: analysis([w.conceptIds[0]!], {
          errors: [{ claim, correction: "c", citation: "kf1" }],
        }),
        cadets: w.cadets,
      }).map((c) => [c.adopted.length, c.comprehension]);
    };
    const first = run();
    expect(run()).toEqual(first);
    expect(first.some(([adopted]) => adopted === 1)).toBe(true);
    expect(first.some(([adopted]) => adopted === 0)).toBe(true);
  });
});

describe("conceptStatus", () => {
  const s = game.status;
  const e = (over: Partial<Parameters<typeof conceptStatus>[0]>) => ({
    turnsTaught: 2,
    comprehensionAvg: 0.4,
    latestAssessmentAvg: null,
    examAvg: null,
    ...over,
  });
  it("covers every branch", () => {
    expect(conceptStatus(e({ turnsTaught: 0 }), s)).toBe("untaught");
    expect(conceptStatus(e({}), s)).toBe("taught"); // early on, low comprehension is normal
    expect(conceptStatus(e({ turnsTaught: 8, comprehensionAvg: 0.4 }), s)).toBe("weak");
    expect(conceptStatus(e({ latestAssessmentAvg: 0.5 }), s)).toBe("weak");
    expect(
      conceptStatus(e({ examAvg: 0.8, latestAssessmentAvg: 0.8, comprehensionAvg: 0.75 }), s),
    ).toBe("mastered");
    expect(
      conceptStatus(e({ examAvg: 0.8, latestAssessmentAvg: 0.8, comprehensionAvg: 0.6 }), s),
    ).toBe("taught");
    expect(
      conceptStatus(e({ examAvg: 0.65, latestAssessmentAvg: 0.65, comprehensionAvg: 0.9 }), s),
    ).toBe("taught");
  });
});

describe("myMastery", () => {
  it("weights exam 0.5, comprehension 0.3, error-free 0.2", () => {
    expect(
      myMastery({
        turnsTaught: 5,
        comprehensionAvg: 1,
        latestAssessmentAvg: 1,
        examAvg: 1,
        unresolvedTeacherErrors: 0,
        keyFacts: 4,
      }),
    ).toBe(1);
    expect(
      myMastery({
        turnsTaught: 5,
        comprehensionAvg: 0.5,
        latestAssessmentAvg: null,
        examAvg: null,
        unresolvedTeacherErrors: 2,
        keyFacts: 4,
      }),
    ).toBeCloseTo(0.3 * 0.5 + 0.2 * 0.5);
    expect(
      myMastery({
        turnsTaught: 5,
        comprehensionAvg: 0,
        latestAssessmentAvg: null,
        examAvg: 0,
        unresolvedTeacherErrors: 9,
        keyFacts: 4,
      }),
    ).toBe(0);
  });
});
