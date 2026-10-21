import { afterEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { smallWorld } from "../test-fixtures/world.js";
import { rivalFor, rivalScore, trophyCount } from "./rival.js";

let h: DbHandle | undefined;
afterEach(() => h?.close());

describe("rival class (V7-05, VD14)", () => {
  it("a stable, believable curve: same School and module, same score; harder classes face a weaker rival", () => {
    const a = rivalScore("sch_1", 0, "standard");
    expect(rivalScore("sch_1", 0, "standard")).toBe(a);
    expect(a).toBeGreaterThan(0.35);
    expect(a).toBeLessThan(0.95);
    expect(rivalScore("sch_1", 0, "ruthless")).toBeLessThan(rivalScore("sch_1", 0, "gentle"));
  });

  it("beating them earns one trophy per exam", async () => {
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    h = w.handle;
    const mod = (
      h.sqlite.prepare("SELECT module_id m FROM concepts LIMIT 1").get() as { m: string }
    ).m;
    h.sqlite
      .prepare(
        "INSERT INTO exams (id, classroom_id, module_id, status, pass_threshold, class_average, created_at) VALUES ('exm_1', ?, ?, 'done', 0.7, 0.99, ?)",
      )
      .run(w.classroomId, mod, new Date().toISOString());
    expect(rivalFor(h, "exm_1")).toMatchObject({ beaten: true, trophy: true });
    rivalFor(h, "exm_1");
    expect(trophyCount(h, w.schoolId)).toBe(1);
  });
});
