import { eq, inArray } from "drizzle-orm";
import type { GameConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { concepts } from "../db/schema.js";
import { conceptStatus, myMastery } from "./status.js";

/** Recomputes status and my_mastery for these concepts from ledgers, exams and teacher errors. */
export function refreshConcepts(handle: DbHandle, conceptIds: string[], cfg: GameConfig["status"]) {
  if (!conceptIds.length) return [];
  const { sqlite, db } = handle;
  const rows = db.select().from(concepts).where(inArray(concepts.id, conceptIds)).all();
  return rows.map((c) => {
    const ledger = sqlite
      .prepare(
        `SELECT avg(l.comprehension) AS comp, avg(l.exposures) AS turns, count(*) AS n
         FROM ledger_entries l JOIN cadets d ON d.id = l.cadet_id
         WHERE l.concept_id = ? AND d.status IN ('enrolled', 'transferred_in')`,
      )
      .get(c.id) as { comp: number | null; turns: number | null; n: number };
    const exam = sqlite
      .prepare(
        `SELECT avg(r.score) AS avg FROM exam_results r JOIN exam_questions q ON q.id = r.question_id WHERE q.concept_id = ?`,
      )
      .get(c.id) as { avg: number | null };
    // Latest assessment = latest exam covering it (assignments join in M4).
    const latest = sqlite
      .prepare(
        `SELECT avg(r.score) AS avg FROM exam_results r JOIN exam_questions q ON q.id = r.question_id
         WHERE q.concept_id = ? AND r.exam_id = (
           SELECT q2.exam_id FROM exam_questions q2 JOIN exams e ON e.id = q2.exam_id
           WHERE q2.concept_id = ? ORDER BY e.created_at DESC LIMIT 1)`,
      )
      .get(c.id, c.id) as { avg: number | null };
    const errors = sqlite
      .prepare("SELECT count(*) AS n FROM teacher_errors WHERE concept_id = ? AND resolved = 0")
      .get(c.id) as { n: number };
    const evidence = {
      turnsTaught: ledger.n ? (ledger.turns ?? 0) : 0,
      comprehensionAvg: ledger.n ? ledger.comp : null,
      latestAssessmentAvg: latest.avg,
      examAvg: exam.avg,
    };
    const status = conceptStatus(evidence, cfg);
    const mastery = myMastery({
      ...evidence,
      unresolvedTeacherErrors: errors.n,
      keyFacts: (JSON.parse(c.keyFactsJson) as string[]).length,
    });
    db.update(concepts).set({ status, myMastery: mastery }).where(eq(concepts.id, c.id)).run();
    return { conceptId: c.id, status, mastery };
  });
}
