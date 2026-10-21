import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { smallWorld } from "../test-fixtures/world.js";
import { planTeachBack, scoreTeachBack } from "./teachBack.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());

describe("teach-back (V5-03)", () => {
  it("a student's misconceptions come out as the wrong sentences; nothing taught, mostly mix-ups", async () => {
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    h = w.handle;
    const concept = h.sqlite
      .prepare(
        "SELECT id, title, key_facts_json k, misconceptions_json m FROM concepts WHERE id = ?",
      )
      .get(w.conceptIds[0]) as { id: string; title: string; k: string; m: string };
    const c = {
      id: concept.id,
      title: concept.title,
      keyFacts: JSON.parse(concept.k) as string[],
      misconceptions: JSON.parse(concept.m) as string[],
    };
    const id = w.cadets[0]!.id;
    const fresh = planTeachBack(h, cfg.game, {
      classroomId: w.classroomId,
      cadetId: id,
      periodId: "per_1",
      concept: c,
    });
    expect(fresh.every((l) => !l.true)).toBe(true);

    h.sqlite
      .prepare(
        "INSERT INTO ledger_entries (cadet_id, concept_id, comprehension, exposures, misconceptions_json) VALUES (?, ?, 0.2, 2, ?)",
      )
      .run(
        id,
        c.id,
        JSON.stringify([
          { text: "The root is in every transaction.", source: "teacher_error", since: "" },
        ]),
      );
    const lines = planTeachBack(h, cfg.game, {
      classroomId: w.classroomId,
      cadetId: id,
      periodId: "per_2",
      concept: c,
    });
    expect(lines.find((l) => l.text === "The root is in every transaction.")?.true).toBe(false);
  });

  it("scores catches, misses and false alarms", () => {
    const lines = [
      { text: "a", true: true },
      { text: "b", true: false },
      { text: "c", true: false },
      { text: "d", true: true },
    ];
    expect(scoreTeachBack(lines, [1, 2])).toEqual({
      caught: 2,
      missed: 0,
      falseAlarms: 0,
      score: 1,
    });
    expect(scoreTeachBack(lines, [1, 3])).toEqual({
      caught: 1,
      missed: 1,
      falseAlarms: 1,
      score: 0.25,
    });
    expect(scoreTeachBack([{ text: "a", true: true }], [])).toMatchObject({ score: 1 });
  });
});
