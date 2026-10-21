import { and, eq, inArray } from "drizzle-orm";
import { stringify as toYaml, parse as parseYaml } from "yaml";
import { EditableCurriculumZ, type EditableCurriculum } from "@lumen/shared";
import type { DbHandle } from "./client.js";
import { newId } from "./ids.js";
import { conceptCitations, concepts, modules } from "./schema.js";

// C-2: hand-edit a School's curriculum as YAML. Ids are kept so cadet ledgers,
// exams and citations stay attached across renames, reorders and merges.

const HEADER = `# Lumen Academy curriculum. Edit, then import with:
#   pnpm cli:curriculum --school "<name>" --import <this file>
# - Rename: change a title (update prerequisites that use the old title).
# - Reorder: move items; list order is teaching order.
# - Merge: copy facts/misconceptions/citations into one concept, delete the other.
# - Delete: remove the item (refused if cadets have already learned it).
# - Add: new module/concept without an id; it needs >= 1 citation (a chunk id).
# Keep the "id" lines on existing items.
`;

export function loadEditableCurriculum(handle: DbHandle, schoolId: string): EditableCurriculum {
  const mods = handle.db
    .select()
    .from(modules)
    .where(eq(modules.schoolId, schoolId))
    .orderBy(modules.ord)
    .all();
  const modIds = mods.map((m) => m.id);
  const cons = modIds.length
    ? handle.db
        .select()
        .from(concepts)
        .where(inArray(concepts.moduleId, modIds))
        .orderBy(concepts.ord)
        .all()
    : [];
  const titleById = new Map(cons.map((c) => [c.id, c.title]));
  const cites = cons.length
    ? handle.db
        .select()
        .from(conceptCitations)
        .where(
          inArray(
            conceptCitations.conceptId,
            cons.map((c) => c.id),
          ),
        )
        .all()
    : [];
  return {
    modules: mods.map((m) => ({
      id: m.id,
      title: m.title,
      goal: m.goal ?? "",
      unit: m.unitTitle ? { sourceId: m.unitSourceId, title: m.unitTitle } : null,
      concepts: cons
        .filter((c) => c.moduleId === m.id)
        .map((c) => ({
          id: c.id,
          title: c.title,
          summary: c.summary,
          keyFacts: JSON.parse(c.keyFactsJson) as string[],
          misconceptions: JSON.parse(c.misconceptionsJson) as string[],
          prerequisites: (JSON.parse(c.prerequisitesJson) as string[])
            .map((id) => titleById.get(id))
            .filter((t): t is string => !!t),
          citations: cites.filter((x) => x.conceptId === c.id).map((x) => x.chunkId),
          difficulty: c.difficulty,
        })),
    })),
  };
}

export const exportCurriculumYaml = (handle: DbHandle, schoolId: string) =>
  HEADER + toYaml(loadEditableCurriculum(handle, schoolId), { lineWidth: 100 });

export class CurriculumEditError extends Error {
  constructor(readonly problems: string[]) {
    super(`curriculum edit rejected:\n- ${problems.join("\n- ")}`);
    this.name = "CurriculumEditError";
  }
}

export interface EditSummary {
  updated: number;
  added: number;
  deleted: number;
  modulesAdded: number;
  modulesDeleted: number;
}

export function importCurriculumYaml(
  handle: DbHandle,
  schoolId: string,
  yamlText: string,
): EditSummary {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new CurriculumEditError([`not valid YAML: ${(err as Error).message}`]);
  }
  const parsed = EditableCurriculumZ.safeParse(raw);
  if (!parsed.success) {
    throw new CurriculumEditError(
      parsed.error.issues.slice(0, 15).map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  return applyCurriculumEdit(handle, schoolId, parsed.data);
}

/** Validates everything first, then applies the edit in one transaction. */
export function applyCurriculumEdit(
  handle: DbHandle,
  schoolId: string,
  edit: EditableCurriculum,
): EditSummary {
  const { db, sqlite } = handle;
  const problems: string[] = [];
  const current = loadEditableCurriculum(handle, schoolId);
  const currentModuleIds = new Set(current.modules.map((m) => m.id!));
  const currentConceptIds = new Set(current.modules.flatMap((m) => m.concepts.map((c) => c.id!)));
  const validChunks = new Set(
    (
      sqlite
        .prepare(
          "SELECT c.id FROM chunks c JOIN sources s ON s.id = c.source_id WHERE s.school_id = ?",
        )
        .all(schoolId) as { id: string }[]
    ).map((r) => r.id),
  );

  const allConcepts = edit.modules.flatMap((m) => m.concepts);
  const titles = new Map<string, number>();
  for (const c of allConcepts)
    titles.set(c.title.toLowerCase(), (titles.get(c.title.toLowerCase()) ?? 0) + 1);
  for (const [t, n] of titles) if (n > 1) problems.push(`duplicate concept title "${t}"`);
  const seenIds = new Set<string>();
  for (const m of edit.modules) {
    if (m.id && !currentModuleIds.has(m.id))
      problems.push(`module id ${m.id} doesn't belong to this School`);
    if (!m.goal.trim()) problems.push(`module "${m.title}" needs a goal`);
  }
  for (const c of allConcepts) {
    if (c.id) {
      if (!currentConceptIds.has(c.id))
        problems.push(`concept id ${c.id} ("${c.title}") doesn't belong to this School`);
      if (seenIds.has(c.id)) problems.push(`concept id ${c.id} appears twice`);
      seenIds.add(c.id);
    }
    for (const p of c.prerequisites) {
      if (!titles.has(p.toLowerCase()))
        problems.push(`"${c.title}": prerequisite "${p}" is not a concept in this curriculum`);
      if (p.toLowerCase() === c.title.toLowerCase())
        problems.push(`"${c.title}" lists itself as a prerequisite`);
    }
    const bad = c.citations.filter((id) => !validChunks.has(id));
    if (bad.length) problems.push(`"${c.title}": unknown chunk ids ${bad.join(", ")}`);
    if (!Number.isInteger(c.difficulty) || c.difficulty < 1 || c.difficulty > 5)
      problems.push(`"${c.title}": difficulty must be 1–5`);
  }
  const removed = [...currentConceptIds].filter((id) => !seenIds.has(id));
  if (removed.length) {
    const ph = removed.map(() => "?").join(",");
    const used = sqlite
      .prepare(
        `SELECT DISTINCT c.title FROM concepts c WHERE c.id IN (${ph}) AND (
           EXISTS (SELECT 1 FROM ledger_entries l WHERE l.concept_id = c.id) OR
           EXISTS (SELECT 1 FROM exam_questions q WHERE q.concept_id = c.id))`,
      )
      .all(...removed) as { title: string }[];
    for (const u of used)
      problems.push(
        `can't delete "${u.title}": cadets have already learned it (merge by keeping its id instead)`,
      );
  }
  if (problems.length) throw new CurriculumEditError(problems);

  return sqlite.transaction(() => {
    const summary: EditSummary = {
      updated: 0,
      added: 0,
      deleted: 0,
      modulesAdded: 0,
      modulesDeleted: 0,
    };
    const idByTitle = new Map<string, string>();
    const pending: Array<{ id: string; prerequisites: string[] }> = [];

    edit.modules.forEach((m, mi) => {
      let moduleId = m.id;
      if (moduleId) {
        db.update(modules)
          .set({ ord: mi, title: m.title, goal: m.goal })
          .where(eq(modules.id, moduleId))
          .run();
      } else {
        moduleId = newId("module");
        db.insert(modules)
          .values({
            id: moduleId,
            schoolId,
            ord: mi,
            title: m.title,
            goal: m.goal,
            unitSourceId: m.unit?.sourceId ?? null,
            unitTitle: m.unit?.title ?? null,
          })
          .run();
        summary.modulesAdded++;
      }
      m.concepts.forEach((c, ci) => {
        const fields = {
          moduleId: moduleId!,
          ord: ci,
          title: c.title,
          summary: c.summary,
          keyFactsJson: JSON.stringify(c.keyFacts),
          misconceptionsJson: JSON.stringify(c.misconceptions),
          difficulty: c.difficulty,
        };
        let conceptId = c.id;
        if (conceptId) {
          db.update(concepts).set(fields).where(eq(concepts.id, conceptId)).run();
          db.delete(conceptCitations).where(eq(conceptCitations.conceptId, conceptId)).run();
          summary.updated++;
        } else {
          conceptId = newId("concept");
          db.insert(concepts)
            .values({ id: conceptId, ...fields, prerequisitesJson: "[]" })
            .run();
          summary.added++;
        }
        for (const chunkId of new Set(c.citations))
          db.insert(conceptCitations).values({ conceptId, chunkId }).run();
        idByTitle.set(c.title.toLowerCase(), conceptId);
        pending.push({ id: conceptId, prerequisites: c.prerequisites });
      });
    });
    for (const p of pending) {
      const ids = p.prerequisites.map((t) => idByTitle.get(t.toLowerCase())!);
      db.update(concepts)
        .set({ prerequisitesJson: JSON.stringify(ids) })
        .where(eq(concepts.id, p.id))
        .run();
    }
    if (removed.length) {
      db.delete(conceptCitations).where(inArray(conceptCitations.conceptId, removed)).run();
      db.delete(concepts).where(inArray(concepts.id, removed)).run();
      summary.deleted = removed.length;
    }
    const keptModules = new Set(edit.modules.map((m) => m.id).filter(Boolean));
    const goneModules = [...currentModuleIds].filter((id) => !keptModules.has(id));
    if (goneModules.length) {
      db.delete(modules)
        .where(and(eq(modules.schoolId, schoolId), inArray(modules.id, goneModules)))
        .run();
      summary.modulesDeleted = goneModules.length;
    }
    return summary;
  })();
}
