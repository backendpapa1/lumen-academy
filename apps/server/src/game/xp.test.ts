import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { smallWorld } from "../test-fixtures/world.js";
import { ClassSession } from "./ClassSession.js";
import { awardXp, periodXp, rankFor, settleTeachingMinutes, standing } from "./xp.js";
import { fakeDeepSeekFactory } from "../test-fixtures/fakeDeepSeek.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());

async function period() {
  const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
  h = w.handle;
  const { factory } = fakeDeepSeekFactory(cfg.models, () => "");
  const s = ClassSession.open(
    { handle: h, factory, game: cfg.game },
    { classroomId: w.classroomId },
  );
  const room = h.sqlite
    .prepare("SELECT school_id FROM classrooms WHERE id = ?")
    .get(w.classroomId) as {
    school_id: string;
  };
  return {
    scope: { schoolId: room.school_id, classroomId: w.classroomId, periodId: s.periodId },
    s,
  };
}

describe("xp", () => {
  it("awards game.yaml amounts and mirrors them on the period", async () => {
    const { scope } = await period();
    expect(awardXp(h!, cfg.game, scope, "questionAnswered")).toBe(cfg.game.xp.questionAnswered);
    expect(settleTeachingMinutes(h!, cfg.game, scope, 7.5 * 60_000)).toBe(
      7 * cfg.game.xp.teachingMinute!,
    );
    const row = h!.sqlite.prepare("SELECT xp_earned FROM periods WHERE id = ?").get(scope.periodId);
    expect(row).toEqual({
      xp_earned: 7 * cfg.game.xp.teachingMinute! + cfg.game.xp.questionAnswered!,
    });
    expect(periodXp(h!, scope.periodId).map((r) => r.kind)).toEqual([
      "teachingMinute",
      "questionAnswered",
    ]);
  });

  it("counts teaching minutes once, even across a resume", async () => {
    const { scope } = await period();
    settleTeachingMinutes(h!, cfg.game, scope, 4 * 60_000);
    expect(settleTeachingMinutes(h!, cfg.game, scope, 4.9 * 60_000)).toBe(0);
    expect(settleTeachingMinutes(h!, cfg.game, scope, 6 * 60_000)).toBe(
      2 * cfg.game.xp.teachingMinute!,
    );
    expect(standing(h!, cfg.game).total).toBe(6 * cfg.game.xp.teachingMinute!);
  });

  it("ranks by threshold, with progress to the next", () => {
    const ranks = cfg.game.ranks;
    expect(rankFor(0, ranks)).toMatchObject({ rank: ranks[0]!.name, next: ranks[1] });
    const mid = rankFor((ranks[1]!.minXp + ranks[2]!.minXp) / 2, ranks);
    expect(mid.rank).toBe(ranks[1]!.name);
    expect(mid.progress).toBeCloseTo(0.5);
    expect(rankFor(10 ** 9, ranks)).toMatchObject({
      rank: ranks.at(-1)!.name,
      next: null,
      progress: 1,
    });
  });
});
