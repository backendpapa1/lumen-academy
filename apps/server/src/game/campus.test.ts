import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { smallWorld } from "../test-fixtures/world.js";
import {
  checkGraduation,
  dayIn,
  refreshTiers,
  resumeTarget,
  schoolTier,
  streak,
} from "./campus.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());

const endedOn = (handle: DbHandle, classroomId: string, iso: string, i: number) =>
  handle.sqlite
    .prepare(
      "INSERT INTO periods (id, classroom_id, started_at, ended_at, planned_minutes) VALUES (?, ?, ?, ?, 15)",
    )
    .run(`per_${i}`, classroomId, iso, iso);

describe("streak (forgiving)", () => {
  it("counts consecutive Lagos days, stays alive through today, keeps the best", async () => {
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    h = w.handle;
    // Oct 10–13 (4 days), gap, Oct 18–19 (2 days). Lagos is UTC+1: 23:30Z on the 12th is the 13th there.
    [
      "2026-10-10T09:00:00Z",
      "2026-10-11T09:00:00Z",
      "2026-10-12T09:00:00Z",
      "2026-10-12T23:30:00Z",
      "2026-10-18T09:00:00Z",
      "2026-10-19T09:00:00Z",
    ].forEach((t, i) => endedOn(h!, w.classroomId, t, i));
    const s = streak(h, cfg.game, new Date("2026-10-20T10:00:00Z"));
    expect(s).toMatchObject({ current: 2, best: 4, missedDays: 1, taughtToday: false });
    // Three days later: the streak is over, but nothing says zero dramatically: best stays.
    expect(streak(h, cfg.game, new Date("2026-10-22T10:00:00Z"))).toMatchObject({
      current: 0,
      best: 4,
      missedDays: 3,
    });
    expect(dayIn("Africa/Lagos", new Date("2026-10-12T23:30:00Z"))).toBe("2026-10-13");
  });
});

describe("tiers, resume and graduation", () => {
  it("goes Frame → Wing as concepts are mastered, and graduates when every module passes", async () => {
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    h = w.handle;
    expect(schoolTier(h, cfg.game, w.schoolId).tier).toBe(1); // a class exists
    // Master both concepts: exam ≥ masteredScore and comprehension ≥ masteredComprehension.
    const moduleId = (
      h.sqlite.prepare("SELECT module_id FROM concepts LIMIT 1").get() as { module_id: string }
    ).module_id;
    h.sqlite
      .prepare(
        "INSERT INTO exams (id, classroom_id, module_id, status, pass_threshold, class_average, created_at) VALUES ('exm_1', ?, ?, 'done', 0.7, 0.9, '2026-10-20')",
      )
      .run(w.classroomId, moduleId);
    for (const [i, c] of w.conceptIds.entries()) {
      h.sqlite
        .prepare(
          "INSERT INTO exam_questions (id, exam_id, ord, kind, prompt, answer_key, rubric, concept_id, citations_json) VALUES (?, 'exm_1', ?, 'short', 'q', 'a', '[]', ?, '[]')",
        )
        .run(`exq_${i}`, i + 1, c);
      h.sqlite
        .prepare(
          "INSERT INTO exam_results (exam_id, question_id, cadet_id, answer, score) VALUES ('exm_1', ?, ?, 'a', 0.9)",
        )
        .run(`exq_${i}`, w.cadets[0]!.id);
      h.sqlite
        .prepare(
          "INSERT INTO ledger_entries (cadet_id, concept_id, comprehension, exposures, misconceptions_json) VALUES (?, ?, 0.9, 8, '[]')",
        )
        .run(w.cadets[0]!.id, c);
    }
    expect(schoolTier(h, cfg.game, w.schoolId)).toMatchObject({ tier: 3, masteredFraction: 1 }); // 100% but no graduation yet
    expect(refreshTiers(h, cfg.game)).toEqual([{ schoolId: w.schoolId, from: 0, to: 3 }]);
    expect(checkGraduation(h, w.classroomId)).toBe(true);
    expect(schoolTier(h, cfg.game, w.schoolId).tier).toBe(4); // Landmark
    expect(
      h.sqlite
        .prepare("SELECT DISTINCT status FROM cadets WHERE classroom_id = ?")
        .all(w.classroomId),
    ).toEqual([{ status: "alumni" }]);
    expect(checkGraduation(h, w.classroomId)).toBe(false); // once
  });

  it("resumes the most recent class with its current concept", async () => {
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    h = w.handle;
    expect(resumeTarget(h)).toBeNull();
    endedOn(h, w.classroomId, "2026-10-20T09:00:00Z", 1);
    h.sqlite
      .prepare("UPDATE classrooms SET current_concept_id = ? WHERE id = ?")
      .run(w.conceptIds[1], w.classroomId);
    expect(resumeTarget(h)).toMatchObject({
      classroomId: w.classroomId,
      classroomName: "Class A",
      conceptTitle: "Block Header",
      inProgress: false,
    });
  });
});
