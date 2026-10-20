import { eq, inArray, sql } from "drizzle-orm";
import type { Curriculum } from "@lumen/shared";
import type { DbHandle } from "./client.js";
import { newId } from "./ids.js";
import { conceptCitations, concepts, modules } from "./schema.js";

/**
 * Replaces a School's curriculum (C-1/C-3). Refuses if any cadet has a ledger
 * entry on the current concepts: re-planning a taught curriculum needs the
 * explicit merge flow (M3/S-5), not a silent wipe.
 */
export function saveCurriculum(
  handle: DbHandle,
  schoolId: string,
  curriculum: Curriculum,
): { modules: number; concepts: number } {
  const { db, sqlite } = handle;
  return sqlite.transaction(() => {
    const oldModuleIds = db
      .select({ id: modules.id })
      .from(modules)
      .where(eq(modules.schoolId, schoolId))
      .all()
      .map((r) => r.id);
    const oldConceptIds = oldModuleIds.length
      ? db
          .select({ id: concepts.id })
          .from(concepts)
          .where(inArray(concepts.moduleId, oldModuleIds))
          .all()
          .map((r) => r.id)
      : [];
    if (oldConceptIds.length) {
      const taught = sqlite
        .prepare(
          `SELECT count(*) n FROM ledger_entries WHERE concept_id IN (${oldConceptIds.map(() => "?").join(",")})`,
        )
        .get(...oldConceptIds) as { n: number };
      if (taught.n > 0)
        throw new Error("this curriculum has already been taught; edit it instead of regenerating");
      db.delete(conceptCitations).where(inArray(conceptCitations.conceptId, oldConceptIds)).run();
      db.delete(concepts).where(inArray(concepts.id, oldConceptIds)).run();
      db.delete(modules).where(inArray(modules.id, oldModuleIds)).run();
    }

    const idByTitle = new Map<string, string>();
    const pending: Array<{ id: string; prerequisites: string[] }> = [];
    curriculum.modules.forEach((m, mi) => {
      const moduleId = newId("module");
      db.insert(modules)
        .values({ id: moduleId, schoolId, ord: mi, title: m.title, goal: m.goal || null })
        .run();
      m.concepts.forEach((c, ci) => {
        const conceptId = newId("concept");
        idByTitle.set(c.title.toLowerCase(), conceptId);
        pending.push({ id: conceptId, prerequisites: c.prerequisites });
        db.insert(concepts)
          .values({
            id: conceptId,
            moduleId,
            ord: ci,
            title: c.title,
            summary: c.summary,
            keyFactsJson: JSON.stringify(c.keyFacts),
            misconceptionsJson: JSON.stringify(c.misconceptions),
            prerequisitesJson: "[]",
            difficulty: c.difficulty,
          })
          .run();
        for (const chunkId of c.citations)
          db.insert(conceptCitations).values({ conceptId, chunkId }).run();
      });
    });
    // Prerequisites are titles in the agent output; store them as concept ids.
    for (const p of pending) {
      const ids = p.prerequisites
        .map((t) => idByTitle.get(t.toLowerCase()))
        .filter((x): x is string => !!x && x !== p.id);
      db.update(concepts)
        .set({ prerequisitesJson: JSON.stringify(ids) })
        .where(eq(concepts.id, p.id))
        .run();
    }
    const count = db
      .select({ n: sql<number>`count(*)` })
      .from(concepts)
      .where(
        inArray(
          concepts.moduleId,
          db.select({ id: modules.id }).from(modules).where(eq(modules.schoolId, schoolId)),
        ),
      )
      .get();
    return { modules: curriculum.modules.length, concepts: count?.n ?? 0 };
  })();
}
