import type { GameConfig } from "@lumen/shared";

// Concept status and mastery (docs/06 §3), derived from ledgers and exams.

export type ConceptStatus = "untaught" | "taught" | "weak" | "mastered";

export interface ConceptEvidence {
  /** Mean teaching turns per cadet on this concept (ledger exposures averaged). */
  turnsTaught: number;
  /** Mean comprehension across enrolled cadets who have an entry, or null. */
  comprehensionAvg: number | null;
  /** Mean score (0..1) on the most recent exam or assignment covering it, or null. */
  latestAssessmentAvg: number | null;
  /** Mean exam score (0..1) on it, or null if never examined. */
  examAvg: number | null;
}

export function conceptStatus(e: ConceptEvidence, cfg: GameConfig["status"]): ConceptStatus {
  if (e.turnsTaught === 0) return "untaught";
  const comp = e.comprehensionAvg ?? 0;
  const weakByAssessment = e.latestAssessmentAvg !== null && e.latestAssessmentAvg < cfg.weakScore;
  // Only after cadets had a fair number of turns: understanding normally takes ~6 (spike M1-S3).
  const weakByComprehension = e.turnsTaught >= cfg.weakMinExposures && comp < cfg.weakComprehension;
  if (weakByAssessment || weakByComprehension) return "weak";
  if (e.examAvg !== null && e.examAvg >= cfg.masteredScore && comp >= cfg.masteredComprehension)
    return "mastered";
  return "taught";
}

/** my_mastery = 0.5 × examAvg + 0.3 × comprehensionAvg + 0.2 × (1 − unresolvedErrors / keyFacts). */
export function myMastery(
  e: ConceptEvidence & { unresolvedTeacherErrors: number; keyFacts: number },
): number {
  const errorTerm = e.keyFacts > 0 ? 1 - Math.min(1, e.unresolvedTeacherErrors / e.keyFacts) : 1;
  const m = 0.5 * (e.examAvg ?? 0) + 0.3 * (e.comprehensionAvg ?? 0) + 0.2 * errorTerm;
  return Math.round(Math.min(1, Math.max(0, m)) * 1000) / 1000;
}
