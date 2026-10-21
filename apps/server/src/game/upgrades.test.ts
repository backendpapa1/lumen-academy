import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { smallWorld } from "../test-fixtures/world.js";
import { newSinceLastPeriod, placeUpgrade, removeUpgrade, upgradeState } from "./upgrades.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());

describe("room upgrades (V7-01)", () => {
  it("slots come with rank; a full room refuses more until one is removed", async () => {
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    h = w.handle;
    expect(upgradeState(h, cfg.game, w.classroomId)).toMatchObject({ slots: 1, chosen: [] });
    expect(placeUpgrade(h, cfg.game, w.classroomId, "goldfish")).toMatchObject({
      chosen: ["goldfish"],
    });
    expect(placeUpgrade(h, cfg.game, w.classroomId, "cat")).toMatchObject({
      error: expect.stringMatching(/slots are used/),
    });
    expect(placeUpgrade(h, cfg.game, w.classroomId, "dragon")).toEqual({
      error: "No such upgrade.",
    });
    // Ranking up to Teacher (500 XP) opens a second slot.
    h.sqlite
      .prepare(
        "INSERT INTO xp_events (ts, kind, amount, school_id, classroom_id) VALUES (?, 'teachingMinute', 600, ?, ?)",
      )
      .run(new Date().toISOString(), w.schoolId, w.classroomId);
    expect(placeUpgrade(h, cfg.game, w.classroomId, "cat")).toMatchObject({
      slots: 2,
      chosen: ["goldfish", "cat"],
    });
    expect(removeUpgrade(h, cfg.game, w.classroomId, "goldfish").chosen).toEqual(["cat"]);
  });

  it("the class notices what's new since it last met", async () => {
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    h = w.handle;
    h.sqlite
      .prepare(
        "INSERT INTO periods (id, classroom_id, started_at, ended_at, planned_minutes) VALUES ('p_old', ?, '2026-10-01T09:00:00Z', '2026-10-01T09:20:00Z', 15)",
      )
      .run(w.classroomId);
    h.sqlite
      .prepare("INSERT INTO room_upgrades VALUES (?, 'plant', '2026-09-30T09:00:00Z')")
      .run(w.classroomId);
    h.sqlite
      .prepare("INSERT INTO room_upgrades VALUES (?, 'goldfish', '2026-10-05T09:00:00Z')")
      .run(w.classroomId);
    expect(newSinceLastPeriod(h, w.classroomId, "p_now")).toEqual(["goldfish"]);
  });
});
