import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  ChapterAnalysisZ,
  CurriculumLinksZ,
  type ChapterAnalysis,
  type Concept,
} from "@lumen/shared";
import type { DbHandle } from "../../db/client.js";
import { newId } from "../../db/ids.js";
import type { ModelFactory } from "../../models/factory.js";
import { callStructured } from "../harness.js";
import { loadPrompt } from "../prompts/load.js";
import { chaptersFor, targetConcepts, type Chapter } from "./chapters.js";
import type { BuildTracker } from "./progress.js";

// The book-by-book curriculum (Paul: "curriculum building on large volumes of
// books ... lost a lot of topics and compressed"). Each source is a unit; each
// of its chapters is read on its own by the Chapter Analyst and becomes a
// module, with as many concepts as the chapter deserves. A unit is saved as
// soon as its book is read, with its coverage (which chapters were taught,
// skipped as front/back matter, or failed). Then the Curriculum Connector links
// concepts across books (and to a School this one continues) and drops
// duplicates. Concept counts follow the material: there is no overall cap.

export interface BuildDeps {
  factory: ModelFactory;
  handle: DbHandle;
}

/** Chapters read at once: enough to be quick, few enough to be kind to the API. */
const CONCURRENCY = 4;
/** Schools a series can reach back through, for prerequisites. */
const SERIES_DEPTH = 5;

export interface ChapterRecord {
  title: string;
  pages: string | null;
  chunks: number;
  state: "taught" | "skipped" | "failed";
  reason?: string;
  concepts: number;
}

export interface BuildSummary {
  units: number;
  modules: number;
  concepts: number;
  skipped: number;
  failed: number;
}

interface SourceRow {
  id: string;
  title: string;
  kind: string;
  filePath: string | null;
}

/** The Schools this one continues, nearest first. */
export function seriesBefore(
  handle: DbHandle,
  schoolId: string,
): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  let id: string | null = schoolId;
  for (let i = 0; i < SERIES_DEPTH && id; i++) {
    const row = handle.sqlite
      .prepare("SELECT continues_school_id c FROM schools WHERE id = ?")
      .get(id) as { c: string | null } | undefined;
    id = row?.c ?? null;
    if (!id || id === schoolId || out.some((s) => s.id === id)) break;
    const s = handle.sqlite.prepare("SELECT id, name FROM schools WHERE id = ?").get(id) as
      { id: string; name: string } | undefined;
    if (!s) break;
    out.push(s);
  }
  return out;
}

/** Concept titles → ids across this School and the ones it continues (this School wins). */
function titleIndex(handle: DbHandle, schoolIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const sid of [...schoolIds].reverse()) {
    const rows = handle.sqlite
      .prepare(
        "SELECT c.id, c.title FROM concepts c JOIN modules m ON m.id = c.module_id WHERE m.school_id = ?",
      )
      .all(sid) as Array<{ id: string; title: string }>;
    for (const r of rows) map.set(r.title.toLowerCase(), r.id);
  }
  return map;
}

function taughtCount(handle: DbHandle, schoolId: string): number {
  return (
    handle.sqlite
      .prepare(
        `SELECT count(*) n FROM ledger_entries l JOIN concepts c ON c.id = l.concept_id
         JOIN modules m ON m.id = c.module_id WHERE m.school_id = ?`,
      )
      .get(schoolId) as { n: number }
  ).n;
}

/** Removes a School's curriculum (refused once any of it has been taught). */
export function clearCurriculum(handle: DbHandle, schoolId: string) {
  if (taughtCount(handle, schoolId) > 0)
    throw new Error("this curriculum has already been taught; edit it instead of regenerating");
  const { sqlite } = handle;
  sqlite.transaction(() => {
    const where =
      "IN (SELECT c.id FROM concepts c JOIN modules m ON m.id = c.module_id WHERE m.school_id = ?)";
    sqlite.prepare(`DELETE FROM concept_citations WHERE concept_id ${where}`).run(schoolId);
    sqlite.prepare(`DELETE FROM self_ratings WHERE concept_id ${where}`).run(schoolId);
    sqlite
      .prepare(
        "DELETE FROM concepts WHERE module_id IN (SELECT id FROM modules WHERE school_id = ?)",
      )
      .run(schoolId);
    sqlite.prepare("DELETE FROM modules WHERE school_id = ?").run(schoolId);
    sqlite.prepare("DELETE FROM curriculum_units WHERE school_id = ?").run(schoolId);
  })();
}

/** Ready sources that don't have a unit yet, in the order they were added. */
export function sourcesWithoutUnit(handle: DbHandle, schoolId: string): SourceRow[] {
  return handle.sqlite
    .prepare(
      `SELECT s.id, s.title, s.kind, s.file_path filePath FROM sources s
       WHERE s.school_id = ? AND s.status = 'ready'
         AND NOT EXISTS (SELECT 1 FROM curriculum_units u WHERE u.school_id = s.school_id AND u.source_id = s.id)
       ORDER BY s.created_at`,
    )
    .all(schoolId) as SourceRow[];
}

/** Runs tasks with at most `n` at once, keeping results in order. */
async function pool<T, R>(
  items: T[],
  n: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!, i);
    }),
  );
  return out;
}

const passages = (ch: Chapter) =>
  ch.chunks.map((c) => `[${c.id}]${c.page ? ` (p. ${c.page})` : ""}\n${c.text}`).join("\n\n");

/** One chapter → its module and concepts, with citations checked against the chapter. */
async function analyse(
  deps: BuildDeps,
  ctx: {
    schoolName: string;
    book: SourceRow;
    bookIndex: number;
    bookCount: number;
    chapter: Chapter;
    chapterIndex: number;
    chapterCount: number;
    earlier: string[];
    track?: BuildTracker;
  },
): Promise<ChapterAnalysis> {
  const { chapter } = ctx;
  const res = await callStructured(deps.factory, "chapterAnalyst", {
    schema: ChapterAnalysisZ,
    name: "chapter_analysis",
    ...(ctx.track ? { callbacks: [ctx.track] } : {}),
    messages: [
      new SystemMessage(
        loadPrompt("chapterAnalyst", {
          schoolName: ctx.schoolName,
          bookTitle: ctx.book.title,
          bookIndex: ctx.bookIndex,
          bookCount: ctx.bookCount,
          chapterTitle: chapter.title,
          pages: chapter.pages ?? "",
          chapterIndex: ctx.chapterIndex,
          chapterCount: ctx.chapterCount,
          target: targetConcepts(chapter),
          earlierTitles: ctx.earlier
            .slice(-150)
            .map((t) => `- ${t}`)
            .join("\n"),
          passages: passages(chapter),
        }),
      ),
      new HumanMessage("Read the chapter and return its module as JSON."),
    ],
  });
  const valid = new Set(chapter.chunks.map((c) => c.id));
  const concepts = res.data.concepts
    .map((c) => ({ ...c, citations: [...new Set(c.citations.filter((id) => valid.has(id)))] }))
    .filter((c) => c.citations.length && c.keyFacts.length >= 2);
  return { ...res.data, concepts };
}

const clean = (c: Concept): Concept => ({
  title: c.title.trim().slice(0, 60),
  summary: c.summary.trim().slice(0, 400),
  keyFacts: c.keyFacts.slice(0, 8).map((f) => f.trim().slice(0, 200)),
  misconceptions: c.misconceptions.slice(0, 5).map((f) => f.trim().slice(0, 200)),
  prerequisites: c.prerequisites,
  citations: c.citations,
  difficulty: Math.min(5, Math.max(1, Math.round(c.difficulty))),
});

/** Saves one book: a module per taught chapter, its concepts and citations, and its coverage. */
function saveUnit(
  handle: DbHandle,
  schoolId: string,
  book: SourceRow,
  unitOrd: number,
  results: Array<{ chapter: Chapter; analysis: ChapterAnalysis | null; error?: string }>,
  pendingPrereqs: Map<string, string[]>,
): ChapterRecord[] {
  const { sqlite } = handle;
  const records: ChapterRecord[] = [];
  sqlite.transaction(() => {
    let ord =
      (
        sqlite
          .prepare("SELECT coalesce(max(ord), -1) m FROM modules WHERE school_id = ?")
          .get(schoolId) as { m: number }
      ).m + 1;
    const taken = new Set(
      (
        sqlite
          .prepare(
            "SELECT lower(c.title) t FROM concepts c JOIN modules m ON m.id = c.module_id WHERE m.school_id = ?",
          )
          .all(schoolId) as Array<{ t: string }>
      ).map((r) => r.t),
    );
    for (const { chapter, analysis, error } of results) {
      const base = { title: chapter.title, pages: chapter.pages, chunks: chapter.chunks.length };
      if (chapter.skip) {
        records.push({ ...base, state: "skipped", reason: chapter.skip, concepts: 0 });
        continue;
      }
      if (!analysis) {
        records.push({
          ...base,
          state: "failed",
          reason: error ?? "couldn't be read",
          concepts: 0,
        });
        continue;
      }
      if (!analysis.teachable || !analysis.concepts.length) {
        records.push({
          ...base,
          state: analysis.teachable ? "failed" : "skipped",
          reason: analysis.teachable
            ? "no concepts came back"
            : analysis.reason || "nothing to teach",
          concepts: 0,
        });
        continue;
      }
      const moduleId = newId("module");
      sqlite
        .prepare(
          "INSERT INTO modules (id, school_id, ord, title, goal, unit_source_id, unit_title) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          moduleId,
          schoolId,
          ord++,
          (analysis.moduleTitle || chapter.title).trim().slice(0, 80),
          analysis.goal.trim() || null,
          book.id,
          book.title,
        );
      let n = 0;
      analysis.concepts.map(clean).forEach((c, ci) => {
        let title = c.title;
        for (let k = 2; taken.has(title.toLowerCase()); k++)
          title = `${c.title.slice(0, 55)} (${k})`;
        taken.add(title.toLowerCase());
        const conceptId = newId("concept");
        sqlite
          .prepare(
            `INSERT INTO concepts (id, module_id, ord, title, summary, key_facts_json, misconceptions_json, prerequisites_json, difficulty)
             VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
          )
          .run(
            conceptId,
            moduleId,
            ci,
            title,
            c.summary,
            JSON.stringify(c.keyFacts),
            JSON.stringify(c.misconceptions),
            c.difficulty,
          );
        const cite = sqlite.prepare(
          "INSERT OR IGNORE INTO concept_citations (concept_id, chunk_id) VALUES (?, ?)",
        );
        for (const chunkId of c.citations) cite.run(conceptId, chunkId);
        pendingPrereqs.set(conceptId, c.prerequisites);
        n++;
      });
      records.push({ ...base, state: "taught", concepts: n });
    }
    sqlite
      .prepare(
        `INSERT INTO curriculum_units (school_id, source_id, title, ord, chapters_json, built_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(school_id, source_id) DO UPDATE SET title = excluded.title, chapters_json = excluded.chapters_json, built_at = excluded.built_at`,
      )
      .run(
        schoolId,
        book.id,
        book.title,
        unitOrd,
        JSON.stringify(records),
        new Date().toISOString(),
      );
  })();
  return records;
}

/** Turns prerequisite titles into concept ids, across this School and its series. */
function resolvePrereqs(handle: DbHandle, schoolId: string, pending: Map<string, string[]>) {
  const index = titleIndex(handle, [schoolId, ...seriesBefore(handle, schoolId).map((s) => s.id)]);
  const update = handle.sqlite.prepare("UPDATE concepts SET prerequisites_json = ? WHERE id = ?");
  const read = handle.sqlite.prepare("SELECT prerequisites_json p FROM concepts WHERE id = ?");
  for (const [id, titles] of pending) {
    const row = read.get(id) as { p: string } | undefined;
    if (!row) continue;
    const ids = new Set(JSON.parse(row.p) as string[]);
    for (const t of titles) {
      const pid = index.get(t.toLowerCase());
      if (pid && pid !== id) ids.add(pid);
    }
    update.run(JSON.stringify([...ids]), id);
  }
}

/** Links across books (and to the School this continues), and drops duplicates. */
async function connect(
  deps: BuildDeps,
  schoolId: string,
  schoolName: string,
  track?: BuildTracker,
) {
  const { sqlite } = deps.handle;
  const rows = sqlite
    .prepare(
      `SELECT c.id, c.title, c.summary, m.title module, coalesce(m.unit_title, 'Notes') unit, m.ord mord, c.ord cord
       FROM concepts c JOIN modules m ON m.id = c.module_id WHERE m.school_id = ? ORDER BY m.ord, c.ord`,
    )
    .all(schoolId) as Array<{
    id: string;
    title: string;
    summary: string;
    module: string;
    unit: string;
  }>;
  const series = seriesBefore(deps.handle, schoolId);
  // Even one book can teach an idea twice across its chapters.
  if (rows.length < 2) return { links: 0, dropped: 0 };
  const continued = series.length
    ? (
        sqlite
          .prepare(
            "SELECT c.title FROM concepts c JOIN modules m ON m.id = c.module_id WHERE m.school_id IN (" +
              series.map(() => "?").join(",") +
              ") ORDER BY m.ord, c.ord LIMIT 400",
          )
          .all(...series.map((s) => s.id)) as Array<{ title: string }>
      )
        .map((r) => `- ${r.title}`)
        .join("\n")
    : "";
  const res = await callStructured(deps.factory, "curriculumConnector", {
    schema: CurriculumLinksZ,
    name: "curriculum_links",
    ...(track ? { callbacks: [track] } : {}),
    messages: [
      new SystemMessage(
        loadPrompt("curriculumConnector", {
          schoolName,
          continues: series.map((s) => s.name).join(", "),
          continuedConcepts: continued,
          concepts: rows
            .map((r) => `${r.unit} · ${r.module} · ${r.title}: ${r.summary.slice(0, 140)}`)
            .join("\n"),
        }),
      ),
      new HumanMessage("Connect the curriculum and return JSON."),
    ],
  });
  const index = titleIndex(deps.handle, [schoolId, ...series.map((s) => s.id)]);
  const own = new Map(rows.map((r) => [r.title.toLowerCase(), r.id]));
  let dropped = 0;
  let links = 0;
  sqlite.transaction(() => {
    for (const d of res.data.duplicates) {
      const drop = own.get(d.drop.toLowerCase());
      const keep = own.get(d.keep.toLowerCase()) ?? index.get(d.keep.toLowerCase());
      if (!drop || !keep || drop === keep || !own.has(d.keep.toLowerCase())) continue;
      sqlite
        .prepare(
          "INSERT OR IGNORE INTO concept_citations (concept_id, chunk_id) SELECT ?, chunk_id FROM concept_citations WHERE concept_id = ?",
        )
        .run(keep, drop);
      sqlite.prepare("DELETE FROM concept_citations WHERE concept_id = ?").run(drop);
      sqlite.prepare("DELETE FROM concepts WHERE id = ?").run(drop);
      // Anything that needed the dropped copy now needs the kept one.
      for (const r of sqlite
        .prepare(
          "SELECT c.id, c.prerequisites_json p FROM concepts c JOIN modules m ON m.id = c.module_id WHERE m.school_id = ?",
        )
        .all(schoolId) as Array<{ id: string; p: string }>) {
        const ids = JSON.parse(r.p) as string[];
        if (ids.includes(drop))
          sqlite
            .prepare("UPDATE concepts SET prerequisites_json = ? WHERE id = ?")
            .run(
              JSON.stringify(
                [...new Set(ids.map((x) => (x === drop ? keep : x)))].filter((x) => x !== r.id),
              ),
              r.id,
            );
      }
      own.delete(d.drop.toLowerCase());
      dropped++;
    }
    for (const p of res.data.prerequisites) {
      const id = own.get(p.concept.toLowerCase());
      if (!id) continue;
      const row = sqlite
        .prepare("SELECT prerequisites_json p FROM concepts WHERE id = ?")
        .get(id) as { p: string };
      const ids = new Set(JSON.parse(row.p) as string[]);
      for (const t of p.needs) {
        const need = index.get(t.toLowerCase());
        if (need && need !== id && !ids.has(need)) {
          ids.add(need);
          links++;
        }
      }
      sqlite
        .prepare("UPDATE concepts SET prerequisites_json = ? WHERE id = ?")
        .run(JSON.stringify([...ids]), id);
    }
    // Modules left empty by merging go.
    sqlite
      .prepare(
        "DELETE FROM modules WHERE school_id = ? AND NOT EXISTS (SELECT 1 FROM concepts c WHERE c.module_id = modules.id)",
      )
      .run(schoolId);
  })();
  return { links, dropped };
}

/**
 * Builds units for these sources (default: every ready source without one),
 * saving each book as it's done. With `rebuild`, the old curriculum goes first.
 */
export async function buildUnits(
  deps: BuildDeps,
  schoolId: string,
  opts: {
    rebuild?: boolean;
    sources?: SourceRow[];
    track?: (books: Array<{ id: string; title: string; chapters: number }>) => BuildTracker;
  } = {},
): Promise<BuildSummary> {
  const { handle } = deps;
  const school = handle.sqlite.prepare("SELECT name FROM schools WHERE id = ?").get(schoolId) as
    { name: string } | undefined;
  if (!school) throw new Error(`no school ${schoolId}`);
  if (opts.rebuild) clearCurriculum(handle, schoolId);
  const books = opts.sources ?? sourcesWithoutUnit(handle, schoolId);
  if (!books.length) throw new Error("this School has no indexed sources yet");
  const plans = [];
  for (const b of books) plans.push({ book: b, chapters: await chaptersFor(handle, b) });
  const tracker = opts.track?.(
    plans.map((p) => ({ id: p.book.id, title: p.book.title, chapters: p.chapters.length })),
  );

  const summary: BuildSummary = { units: 0, modules: 0, concepts: 0, skipped: 0, failed: 0 };
  const pending = new Map<string, string[]>();
  let unitOrd =
    (
      handle.sqlite
        .prepare("SELECT coalesce(max(ord), -1) m FROM curriculum_units WHERE school_id = ?")
        .get(schoolId) as {
        m: number;
      }
    ).m + 1;
  for (const [bi, { book, chapters }] of plans.entries()) {
    tracker?.startBook(book.id);
    const earlier = [...titleIndex(handle, [schoolId]).keys()];
    const results = await pool(chapters, CONCURRENCY, async (chapter, ci) => {
      if (chapter.skip) {
        tracker?.chapterDone(book.id);
        return { chapter, analysis: null };
      }
      try {
        const analysis = await analyse(deps, {
          schoolName: school.name,
          book,
          bookIndex: bi + 1,
          bookCount: plans.length,
          chapter,
          chapterIndex: ci + 1,
          chapterCount: chapters.length,
          earlier,
          ...(tracker ? { track: tracker } : {}),
        });
        tracker?.chapterDone(book.id);
        return { chapter, analysis };
      } catch (err) {
        // A budget stop or a missing key ends the build; anything else is one failed chapter.
        if (/budget|is not set \(needed for|401|403/i.test((err as Error).message)) throw err;
        tracker?.chapterDone(book.id);
        return { chapter, analysis: null, error: (err as Error).message.slice(0, 160) };
      }
    });
    const records = saveUnit(handle, schoolId, book, unitOrd++, results, pending);
    resolvePrereqs(handle, schoolId, pending);
    const taught = records.filter((r) => r.state === "taught");
    summary.units++;
    summary.modules += taught.length;
    summary.concepts += taught.reduce((n, r) => n + r.concepts, 0);
    summary.skipped += records.filter((r) => r.state === "skipped").length;
    summary.failed += records.filter((r) => r.state === "failed").length;
    tracker?.bookDone(
      book.id,
      `Saved “${book.title}”: ${taught.length} modules, ${taught.reduce((n, r) => n + r.concepts, 0)} concepts`,
    );
  }

  tracker?.stage("ordering", "Connecting the books: what builds on what, and repeats", 0.93);
  try {
    const { dropped } = await connect(deps, schoolId, school.name, tracker);
    summary.concepts -= dropped;
  } catch (err) {
    // The books are saved; links across them are a bonus.
    console.warn("curriculum connector skipped:", (err as Error).message);
  }
  resolvePrereqs(handle, schoolId, pending);
  return summary;
}

/** Re-reads the chapters of one unit that failed, adding what they teach. */
export async function fillGaps(
  deps: BuildDeps,
  schoolId: string,
  sourceId: string,
  track?: (books: Array<{ id: string; title: string; chapters: number }>) => BuildTracker,
): Promise<{ filled: number; stillFailed: number; concepts: number }> {
  const { handle } = deps;
  const unit = handle.sqlite
    .prepare(
      "SELECT title, ord, chapters_json c FROM curriculum_units WHERE school_id = ? AND source_id = ?",
    )
    .get(schoolId, sourceId) as { title: string; ord: number; c: string } | undefined;
  const book = handle.sqlite
    .prepare(
      "SELECT id, title, kind, file_path filePath FROM sources WHERE id = ? AND school_id = ?",
    )
    .get(sourceId, schoolId) as SourceRow | undefined;
  if (!unit || !book) throw new Error("that book isn't in this curriculum");
  const school = handle.sqlite.prepare("SELECT name FROM schools WHERE id = ?").get(schoolId) as {
    name: string;
  };
  const records = JSON.parse(unit.c) as ChapterRecord[];
  const failed = new Set(records.filter((r) => r.state === "failed").map((r) => r.title));
  const chapters = (await chaptersFor(handle, book)).filter((c) => failed.has(c.title));
  if (!chapters.length) return { filled: 0, stillFailed: 0, concepts: 0 };
  const tracker = track?.([{ id: book.id, title: book.title, chapters: chapters.length }]);
  tracker?.startBook(book.id);
  const earlier = [...titleIndex(handle, [schoolId]).keys()];
  const results = await pool(chapters, CONCURRENCY, async (chapter, ci) => {
    try {
      const analysis = await analyse(deps, {
        schoolName: school.name,
        book,
        bookIndex: unit.ord + 1,
        bookCount: unit.ord + 1,
        chapter,
        chapterIndex: ci + 1,
        chapterCount: chapters.length,
        earlier,
        ...(tracker ? { track: tracker } : {}),
      });
      tracker?.chapterDone(book.id);
      return { chapter, analysis };
    } catch (err) {
      tracker?.chapterDone(book.id);
      return { chapter, analysis: null, error: (err as Error).message.slice(0, 160) };
    }
  });
  const pending = new Map<string, string[]>();
  // New modules go after the unit's existing ones; saveUnit appends, then the order is tidied.
  const fresh = saveUnit(handle, schoolId, book, unit.ord, results, pending);
  const merged = records.map((r) => fresh.find((f) => f.title === r.title) ?? r);
  handle.sqlite
    .prepare("UPDATE curriculum_units SET chapters_json = ? WHERE school_id = ? AND source_id = ?")
    .run(JSON.stringify(merged), schoolId, sourceId);
  reorderModules(handle, schoolId);
  resolvePrereqs(handle, schoolId, pending);
  const got = fresh.filter((r) => r.state === "taught");
  tracker?.bookDone(book.id, `Filled ${got.length} of ${chapters.length} gaps in “${book.title}”`);
  return {
    filled: got.length,
    stillFailed: fresh.filter((r) => r.state === "failed").length,
    concepts: got.reduce((n, r) => n + r.concepts, 0),
  };
}

/** Modules in unit order, then each unit's chapters in book order (by their first cited page). */
function reorderModules(handle: DbHandle, schoolId: string) {
  const rows = handle.sqlite
    .prepare(
      `SELECT m.id, coalesce(u.ord, 1e9) uord, m.ord mord,
         (SELECT min(k.ord) FROM concept_citations cc JOIN chunks k ON k.id = cc.chunk_id
           JOIN concepts c ON c.id = cc.concept_id WHERE c.module_id = m.id) first
       FROM modules m LEFT JOIN curriculum_units u ON u.school_id = m.school_id AND u.source_id = m.unit_source_id
       WHERE m.school_id = ? ORDER BY uord, first, mord`,
    )
    .all(schoolId) as Array<{ id: string }>;
  const set = handle.sqlite.prepare("UPDATE modules SET ord = ? WHERE id = ?");
  handle.sqlite.transaction(() => rows.forEach((r, i) => set.run(i, r.id)))();
}
