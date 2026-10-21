import type { GameConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { conceptStatus, type ConceptStatus } from "./status.js";

/** C-4: each concept's status across the School's cadets, alumni included (mastery is history). */
export function schoolConceptStatuses(
  handle: DbHandle,
  schoolId: string,
  cfg: GameConfig["status"],
): Record<string, { status: ConceptStatus; comprehension: number | null; turns: number }> {
  const rows = handle.sqlite
    .prepare(
      `SELECT c.id AS conceptId, avg(l.exposures) AS turns, avg(l.comprehension) AS comp
       FROM concepts c JOIN modules m ON m.id = c.module_id
       LEFT JOIN ledger_entries l ON l.concept_id = c.id
         AND l.cadet_id IN (SELECT d.id FROM cadets d JOIN classrooms r ON r.id = d.classroom_id
                            WHERE r.school_id = ? AND d.status IN ('enrolled','transferred_in','alumni'))
       WHERE m.school_id = ? GROUP BY c.id`,
    )
    .all(schoolId, schoolId) as Array<{
    conceptId: string;
    turns: number | null;
    comp: number | null;
  }>;
  // E-5: exam results count. latest = the most recent exam covering the concept.
  const exam = handle.sqlite
    .prepare(
      `SELECT q.concept_id AS conceptId, e.created_at AS at, avg(r.score) AS avg
       FROM exam_results r JOIN exam_questions q ON q.id = r.question_id JOIN exams e ON e.id = r.exam_id
       JOIN classrooms c ON c.id = e.classroom_id WHERE c.school_id = ? GROUP BY q.concept_id, e.id`,
    )
    .all(schoolId) as Array<{ conceptId: string; at: string; avg: number }>;
  const examOf = (id: string) => {
    const xs = exam.filter((x) => x.conceptId === id).sort((a, b) => b.at.localeCompare(a.at));
    if (!xs.length) return { latest: null, mean: null };
    return { latest: xs[0]!.avg, mean: xs.reduce((s, x) => s + x.avg, 0) / xs.length };
  };
  return Object.fromEntries(
    rows.map((r) => {
      const turns = r.turns ?? 0;
      const e = examOf(r.conceptId);
      const status = conceptStatus(
        {
          turnsTaught: turns,
          comprehensionAvg: r.comp,
          latestAssessmentAvg: e.latest,
          examAvg: e.mean,
        },
        cfg,
      );
      return [r.conceptId, { status, comprehension: r.comp, turns: Math.round(turns * 10) / 10 }];
    }),
  );
}
