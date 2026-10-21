import type { GameConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { conceptStatus, type ConceptStatus } from "./status.js";

/** C-4: each concept's status across the School's enrolled cadets (assessments join in M4). */
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
                            WHERE r.school_id = ? AND d.status IN ('enrolled','transferred_in'))
       WHERE m.school_id = ? GROUP BY c.id`,
    )
    .all(schoolId, schoolId) as Array<{
    conceptId: string;
    turns: number | null;
    comp: number | null;
  }>;
  return Object.fromEntries(
    rows.map((r) => {
      const turns = r.turns ?? 0;
      const status = conceptStatus(
        { turnsTaught: turns, comprehensionAvg: r.comp, latestAssessmentAvg: null, examAvg: null },
        cfg,
      );
      return [r.conceptId, { status, comprehension: r.comp, turns: Math.round(turns * 10) / 10 }];
    }),
  );
}
