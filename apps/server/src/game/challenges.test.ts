import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { smallWorld } from "../test-fixtures/world.js";
import { acceptChallenge, challengeProgress, currentChallenge, thisWeek } from "./challenges.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());
const now = new Date("2026-10-21T12:00:00Z"); // a Wednesday; the week starts 2026-10-19

describe("weekly challenges (V7-04)", () => {
  it("a new challenge each week, in a fixed rotation", () => {
    const a = thisWeek(cfg.game, now);
    expect(a).toMatchObject({ week: "2026-W43", monday: "2026-10-19" });
    expect(thisWeek(cfg.game, new Date("2026-10-28T12:00:00Z")).kind).not.toBe(a.kind);
  });

  it("everyone speaks: counts a class where every student was heard", async () => {
    const w = await smallWorld([
      { attention: 0.5, skepticism: 0.5 },
      { attention: 0.5, skepticism: 0.5 },
    ]);
    h = w.handle;
    h.sqlite
      .prepare(
        "INSERT INTO periods (id, classroom_id, started_at, planned_minutes) VALUES ('p1', ?, '2026-10-20T09:00:00Z', 15)",
      )
      .run(w.classroomId);
    const say = h.sqlite.prepare(
      "INSERT INTO messages (id, period_id, speaker, kind, text, created_at) VALUES (?, 'p1', ?, 'question', 'Why?', '2026-10-20T09:01:00Z')",
    );
    say.run("m1", w.cadets[0]!.id);
    expect(challengeProgress(h, "everyone_speaks", "2026-10-19")).toBe(0);
    say.run("m2", w.cadets[1]!.id);
    expect(challengeProgress(h, "everyone_speaks", "2026-10-19")).toBe(1);
  });

  it("opt-in: nothing counts until I take it on; done pays XP and a sticker once", async () => {
    const w = await smallWorld([
      { attention: 0.5, skepticism: 0.5 },
      { attention: 0.5, skepticism: 0.5 },
    ]);
    h = w.handle;
    const game = { ...cfg.game };
    const { kind } = thisWeek(game, now);
    expect(currentChallenge(h, game, now)).toMatchObject({ accepted: false, done: 0 });
    acceptChallenge(h, game, now);
    // Make this week's challenge come true, whichever it is.
    h.sqlite
      .prepare(
        "INSERT INTO periods (id, classroom_id, kind, started_at, planned_minutes) VALUES ('p1', ?, ?, '2026-10-20T09:00:00Z', 15)",
      )
      .run(w.classroomId, kind === "socratic" ? "socratic" : "class");
    for (let i = 0; i < 6; i++) {
      h.sqlite
        .prepare(
          "INSERT INTO messages (id, period_id, speaker, kind, text, concept_id, created_at) VALUES (?, 'p1', 'teacher', 'lecture', ?, ?, '2026-10-20T09:02:00Z')",
        )
        .run(`t${i}`, "For example, pairs of things go up and up.", w.conceptIds[i % 2]);
      h.sqlite
        .prepare(
          "INSERT INTO turns (id, period_id, ord, teacher_message_id, analysis_json, reactions_json, created_at) VALUES (?, 'p1', ?, ?, '{}', '{}', '2026-10-20T09:02:00Z')",
        )
        .run(`trn${i}`, i + 1, `t${i}`);
    }
    for (const c of w.cadets)
      h.sqlite
        .prepare(
          "INSERT INTO messages (id, period_id, speaker, kind, text, created_at) VALUES (?, 'p1', ?, 'question', 'Why?', '2026-10-20T09:03:00Z')",
        )
        .run(`q${c.id}`, c.id);
    if (kind === "no_jargon") {
      h.sqlite
        .prepare(
          "INSERT INTO periods (id, classroom_id, started_at, planned_minutes) VALUES ('p2', ?, '2026-10-20T10:00:00Z', 15), ('p3', ?, '2026-10-20T11:00:00Z', 15)",
        )
        .run(w.classroomId, w.classroomId);
      for (const p of ["p2", "p3"])
        for (let i = 0; i < 5; i++)
          h.sqlite
            .prepare(
              "INSERT INTO messages (id, period_id, speaker, kind, text, created_at) VALUES (?, ?, 'teacher', 'lecture', 'Plain words for plain ideas.', '2026-10-20T10:01:00Z')",
            )
            .run(`${p}${i}`, p);
    }
    const c = currentChallenge(h, game, now);
    expect(c).toMatchObject({ accepted: true, completed: true });
    const xp = () =>
      (
        h!.sqlite
          .prepare("SELECT count(*) n FROM xp_events WHERE kind = 'challengeDone'")
          .get() as { n: number }
      ).n;
    expect(xp()).toBe(1);
    currentChallenge(h, game, now);
    expect(xp()).toBe(1);
    expect(
      h.sqlite.prepare("SELECT count(*) n FROM stickers WHERE kind = 'challenge'").get(),
    ).toEqual({ n: 1 });
  });
});
