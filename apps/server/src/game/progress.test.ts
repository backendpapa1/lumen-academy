import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { smallWorld } from "../test-fixtures/world.js";
import { mondayOf, progress } from "./progress.js";
import { fallbackProfile, numbersAreOurs, statLines, styleStats } from "./styleProfile.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());

async function world() {
  const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
  h = w.handle;
  const period = (id: string, at: string, ms: number, energy: string | null) =>
    h!.sqlite
      .prepare(
        "INSERT INTO periods (id, classroom_id, started_at, ended_at, planned_minutes, elapsed_ms, energy) VALUES (?, ?, ?, ?, 15, ?, ?)",
      )
      .run(id, w.classroomId, at, at, ms, energy);
  let n = 0;
  const say = (
    pid: string,
    at: string,
    text: string,
    spoken = false,
    clarity = 0.8,
    accuracy = 0.9,
  ) => {
    const mid = `msg_${++n}`;
    h!.sqlite
      .prepare(
        "INSERT INTO messages (id, period_id, speaker, kind, text, meta_json, created_at) VALUES (?, ?, 'teacher', 'lecture', ?, ?, ?)",
      )
      .run(mid, pid, text, spoken ? '{"spoken":true}' : null, at);
    h!.sqlite
      .prepare(
        "INSERT INTO turns (id, period_id, ord, teacher_message_id, analysis_json, reactions_json, created_at) VALUES (?, ?, ?, ?, ?, '{}', ?)",
      )
      .run(
        `trn_${n}`,
        pid,
        n,
        mid,
        JSON.stringify({ teaching: { clarity, accuracy, coverage: [], errors: [] } }),
        at,
      );
  };
  return { w, period, say };
}

describe("progress charts (V7-06)", () => {
  it("buckets minutes, sessions, voice share and mastery by week; energy days separately", async () => {
    const { w, period, say } = await world();
    period("per_a", "2026-10-13T09:00:00Z", 20 * 60_000, "low");
    say("per_a", "2026-10-13T09:05:00Z", "It's like a tournament bracket.", true, 0.6, 0.7);
    period("per_b", "2026-10-20T09:00:00Z", 10 * 60_000, "high");
    say(
      "per_b",
      "2026-10-20T09:05:00Z",
      "For example, four transactions make two pairs.",
      false,
      1,
      1,
    );
    say("per_b", "2026-10-20T09:06:00Z", "Does that make sense?", true, 0.8, 1);
    h!.sqlite
      .prepare("UPDATE concepts SET mastered_at = '2026-10-20T10:00:00Z' WHERE id = ?")
      .run(w.conceptIds[0]);
    const p = progress(h!, cfg.game, new Date("2026-10-21T09:00:00Z"), 3);
    expect(p.weeks.map((x) => x.week)).toEqual(["2026-10-05", "2026-10-12", "2026-10-19"]);
    expect(p.weeks[1]).toMatchObject({ minutes: 20, sessions: 1, voice: 1, clarity: 0.6 });
    expect(p.weeks[2]).toMatchObject({
      minutes: 10,
      sessions: 1,
      mastered: 1,
      voice: 0.5,
      accuracy: 1,
    });
    expect(p.energy.find((e) => e.energy === "high")).toMatchObject({ sessions: 1, clarity: 0.9 });
    expect(mondayOf("2026-10-25")).toBe("2026-10-19");
  });
});

describe("teaching-style profile (V7-07)", () => {
  it("counts analogies, examples, checks and length from my turns; the coach can't invent numbers", async () => {
    const { period, say } = await world();
    period("per_a", "2026-10-13T09:00:00Z", 20 * 60_000, null);
    say("per_a", "2026-10-13T09:01:00Z", "It's like a tournament bracket where winners meet.");
    say("per_a", "2026-10-13T09:02:00Z", "For example, four transactions make two pairs.");
    say("per_a", "2026-10-13T09:03:00Z", "Does that make sense?");
    say("per_a", "2026-10-13T09:04:00Z", "The root goes in the header.");
    const s = styleStats(h!);
    expect(s).toMatchObject({ turns: 4, analogies: 0.25, examples: 0.25, checks: 0.25 });
    expect(s.words).toBeCloseTo((8 + 7 + 4 + 6) / 4);
    const lines = statLines(s);
    expect(numbersAreOurs("You use analogies in 25% of your turns.", lines)).toBe(true);
    expect(numbersAreOurs("You use analogies in 40% of your turns.", lines)).toBe(false);
    expect(fallbackProfile(s).sentences).toHaveLength(3);
  });
});
