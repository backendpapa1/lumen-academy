import { afterEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { smallWorld } from "../test-fixtures/world.js";
import { confusionMap } from "./insight.js";

let h: DbHandle | undefined;
afterEach(() => h?.close());

describe("confusion map (V5-07)", () => {
  it("per explanation: who was confused, and who it cleared", async () => {
    const w = await smallWorld([
      { attention: 0.5, skepticism: 0.5 },
      { attention: 0.5, skepticism: 0.5 },
    ]);
    h = w.handle;
    const [a, b] = [w.cadets[0]!.id, w.cadets[1]!.id];
    const now = new Date().toISOString();
    h.sqlite
      .prepare(
        "INSERT INTO periods (id, classroom_id, started_at, planned_minutes) VALUES ('per_1', ?, ?, 15)",
      )
      .run(w.classroomId, now);
    const say = h.sqlite.prepare(
      "INSERT INTO messages (id, period_id, speaker, kind, text, created_at) VALUES (?, 'per_1', 'teacher', 'lecture', ?, ?)",
    );
    const turn = h.sqlite.prepare(
      "INSERT INTO turns (id, period_id, ord, teacher_message_id, analysis_json, reactions_json, created_at) VALUES (?, 'per_1', ?, ?, ?, ?, ?)",
    );
    const reactions = (sa: string, sb: string) =>
      JSON.stringify({
        reactions: [
          { cadetId: a, state: sa },
          { cadetId: b, state: sb },
        ],
        handRaises: [],
      });
    say.run("m1", "Hashes are pairs of pairs.", now);
    turn.run(
      "t1",
      1,
      "m1",
      JSON.stringify({ ledgerDeltas: [] }),
      reactions("confused", "confused"),
      now,
    );
    say.run("m2", "Like a tournament bracket: winners meet until one is left.", now);
    turn.run(
      "t2",
      2,
      "m2",
      JSON.stringify({ ledgerDeltas: [{ cadetId: a, resolvedMisconception: "x" }] }),
      reactions("excited", "confused"),
      now,
    );
    const map = confusionMap(h, "per_1");
    expect(map.map((t) => [t.confused.length, t.cleared.length, t.fixed])).toEqual([
      [2, 0, 0],
      [1, 1, 1],
    ]);
  });
});
