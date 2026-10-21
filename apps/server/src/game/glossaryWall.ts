import type { TeachingAnalysis } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { newId } from "../db/ids.js";

// The glossary wall (V6-08): each term I define is pinned in class, in my own
// words, marked when it disagrees with the key facts. A later definition of
// the same term replaces the earlier one (the wall shows what I say now).

export interface WallTerm {
  term: string;
  definition: string;
  agrees: boolean;
  note: string | null;
}

const key = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");

export function pinDefinitions(
  handle: DbHandle,
  input: {
    schoolId: string;
    periodId: string;
    conceptId: string | null;
    definitions: NonNullable<TeachingAnalysis["definitions"]>;
  },
): number {
  const now = new Date().toISOString();
  const upsert = handle.sqlite.prepare(
    `INSERT INTO glossary_terms (id, school_id, term, definition, agrees, note, concept_id, period_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(school_id, term) DO UPDATE SET definition = excluded.definition, agrees = excluded.agrees,
       note = excluded.note, concept_id = excluded.concept_id, period_id = excluded.period_id, updated_at = excluded.updated_at`,
  );
  let n = 0;
  handle.sqlite.transaction(() => {
    for (const d of input.definitions) {
      const term = key(d.term);
      if (!term || term.length > 60) continue;
      upsert.run(
        newId("term"),
        input.schoolId,
        term,
        d.definition.trim(),
        d.agrees ? 1 : 0,
        d.agrees ? null : (d.note ?? null),
        input.conceptId,
        input.periodId,
        now,
        now,
      );
      n++;
    }
  })();
  return n;
}

export function wallTerms(handle: DbHandle, schoolId: string, limit = 40): WallTerm[] {
  return (
    handle.sqlite
      .prepare(
        "SELECT term, definition, agrees, note FROM glossary_terms WHERE school_id = ? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(schoolId, limit) as Array<{
      term: string;
      definition: string;
      agrees: number;
      note: string | null;
    }>
  ).map((r) => ({ ...r, agrees: r.agrees === 1 }));
}
