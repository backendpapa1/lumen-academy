import type { TeachingAnalysis } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import type { Misconception } from "./ledger.js";
import { knowledgePack, type KnowledgePack, type TaughtFact } from "./knowledgePack.js";

// Knowledge packs from the database (ADR-003): which key facts the Director
// credited as covered in this classroom, and this cadet's ledger.

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/** Director coverage strings are meant to be verbatim key facts; match loosely in case of small edits. */
function matchesFact(covered: string, fact: string): boolean {
  const a = norm(covered);
  const b = norm(fact);
  return a === b || (a.length > 20 && (b.includes(a) || a.includes(b)));
}

export function taughtFacts(
  handle: DbHandle,
  classroomId: string,
  conceptId: string,
  keyFacts: string[],
): TaughtFact[] {
  const rows = handle.sqlite
    .prepare(
      `SELECT t.analysis_json FROM turns t JOIN periods p ON p.id = t.period_id WHERE p.classroom_id = ?`,
    )
    .all(classroomId) as { analysis_json: string }[];
  const counts = new Map(keyFacts.map((f) => [f, 0]));
  for (const r of rows) {
    const a = JSON.parse(r.analysis_json) as TeachingAnalysis;
    if (!a.conceptIds.includes(conceptId)) continue;
    for (const covered of a.teaching.coverage) {
      const fact = keyFacts.find((f) => matchesFact(covered, f));
      if (fact) counts.set(fact, (counts.get(fact) ?? 0) + 1);
    }
  }
  return keyFacts.map((fact) => ({ fact, timesCovered: counts.get(fact) ?? 0 }));
}

export function cadetPack(
  handle: DbHandle,
  input: {
    classroomId: string;
    cadetId: string;
    concept: { id: string; title: string; keyFacts: string[] };
    purpose: string;
  },
): KnowledgePack {
  const ledger = handle.sqlite
    .prepare(
      "SELECT comprehension, misconceptions_json FROM ledger_entries WHERE cadet_id = ? AND concept_id = ?",
    )
    .get(input.cadetId, input.concept.id) as
    { comprehension: number; misconceptions_json: string } | undefined;
  return knowledgePack({
    conceptTitle: input.concept.title,
    taught: taughtFacts(handle, input.classroomId, input.concept.id, input.concept.keyFacts),
    comprehension: ledger?.comprehension ?? 0,
    misconceptions: ledger
      ? (JSON.parse(ledger.misconceptions_json) as Misconception[]).map((m) => m.text)
      : [],
    seed: { cadetId: input.cadetId, conceptId: input.concept.id, purpose: input.purpose },
  });
}
