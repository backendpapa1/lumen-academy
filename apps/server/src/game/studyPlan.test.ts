import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { smallWorld } from "../test-fixtures/world.js";
import { parseExamDate, prerequisiteOrder, studyPlan } from "./studyPlan.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());

describe("goal-shaped curriculum (V6-07)", () => {
  it("reads 'Friday', 'in 5 days', 'next Tuesday' and dates", () => {
    const today = "2026-10-21"; // a Wednesday
    expect(parseExamDate("Friday", today)).toBe("2026-10-23");
    expect(parseExamDate("on friday", today)).toBe("2026-10-23");
    expect(parseExamDate("wednesday", today)).toBe("2026-10-28");
    expect(parseExamDate("next tuesday", today)).toBe("2026-11-03");
    expect(parseExamDate("in 5 days", today)).toBe("2026-10-26");
    expect(parseExamDate("in 2 weeks", today)).toBe("2026-11-04");
    expect(parseExamDate("2026-12-01", today)).toBe("2026-12-01");
    expect(parseExamDate("soonish", today)).toBeNull();
  });

  it("puts prerequisites first, even when the curriculum lists them later", () => {
    const order = prerequisiteOrder([
      { id: "path", prereqs: ["merkle"] },
      { id: "merkle", prereqs: ["hash"] },
      { id: "hash", prereqs: [] },
    ]);
    expect(order.map((x) => x.id)).toEqual(["hash", "merkle", "path"]);
  });

  it("spreads what's left across the days before the exam; mastered work drops out", async () => {
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    h = w.handle;
    h.sqlite.prepare("UPDATE schools SET exam_date = '2026-10-23' WHERE id = ?").run(w.schoolId);
    const plan = studyPlan(h, cfg.game, w.schoolId, new Date("2026-10-21T09:00:00Z"))!;
    expect(plan.daysLeft).toBe(2);
    expect(plan.days.map((d) => d.label)).toEqual(["Today", "Tomorrow"]);
    const all = plan.days.flatMap((d) => d.concepts.map((c) => c.id));
    expect(all.sort()).toEqual([...w.conceptIds].sort());
    expect(plan.days.every((d) => d.concepts.length > 0)).toBe(true);
  });
});
