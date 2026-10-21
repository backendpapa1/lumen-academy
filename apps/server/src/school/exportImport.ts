import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { GameConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { yearbookMarkdown } from "./yearbook.js";

// School export/import (O-5, docs/06 §5): every row that belongs to a School,
// its original source files, its generated images and its embeddings, in one
// zip, so it moves to another machine (or back) with no API calls.

// 2 (V2/V3): learned mishearings, self-ratings, memory half-lives, journal
// fields, period kind and energy, the parking lot, interests, arcs, stickers,
// source links, the glossary wall, source peeks and board diagrams.
// Version 1 exports still import: the new columns have defaults.
const VERSION = 2;
const READS = [1, 2];

/** Tables in foreign-key order, each with the rows that belong to the School. */
const TABLES: Array<[table: string, where: string]> = [
  ["schools", "id = :school"],
  ["sources", "school_id = :school"],
  ["chunks", "source_id IN (SELECT id FROM sources WHERE school_id = :school)"],
  ["modules", "school_id = :school"],
  ["concepts", "module_id IN (SELECT id FROM modules WHERE school_id = :school)"],
  [
    "concept_citations",
    "concept_id IN (SELECT c.id FROM concepts c JOIN modules m ON m.id = c.module_id WHERE m.school_id = :school)",
  ],
  ["classrooms", "school_id = :school"],
  ["cadets", "classroom_id IN (SELECT id FROM classrooms WHERE school_id = :school)"],
  [
    "ledger_entries",
    "cadet_id IN (SELECT d.id FROM cadets d JOIN classrooms c ON c.id = d.classroom_id WHERE c.school_id = :school)",
  ],
  ["periods", "classroom_id IN (SELECT id FROM classrooms WHERE school_id = :school)"],
  [
    "messages",
    "period_id IN (SELECT p.id FROM periods p JOIN classrooms c ON c.id = p.classroom_id WHERE c.school_id = :school)",
  ],
  [
    "turns",
    "period_id IN (SELECT p.id FROM periods p JOIN classrooms c ON c.id = p.classroom_id WHERE c.school_id = :school)",
  ],
  [
    "teacher_errors",
    "turn_id IN (SELECT t.id FROM turns t JOIN periods p ON p.id = t.period_id JOIN classrooms c ON c.id = p.classroom_id WHERE c.school_id = :school)",
  ],
  [
    "exit_tickets",
    "period_id IN (SELECT p.id FROM periods p JOIN classrooms c ON c.id = p.classroom_id WHERE c.school_id = :school)",
  ],
  ["assignments", "classroom_id IN (SELECT id FROM classrooms WHERE school_id = :school)"],
  [
    "submissions",
    "assignment_id IN (SELECT a.id FROM assignments a JOIN classrooms c ON c.id = a.classroom_id WHERE c.school_id = :school)",
  ],
  ["exams", "classroom_id IN (SELECT id FROM classrooms WHERE school_id = :school)"],
  [
    "exam_questions",
    "exam_id IN (SELECT e.id FROM exams e JOIN classrooms c ON c.id = e.classroom_id WHERE c.school_id = :school)",
  ],
  [
    "exam_results",
    "exam_id IN (SELECT e.id FROM exams e JOIN classrooms c ON c.id = e.classroom_id WHERE c.school_id = :school)",
  ],
  ["debriefs", "classroom_id IN (SELECT id FROM classrooms WHERE school_id = :school)"],
  ["xp_events", "school_id = :school"],
  ["speech_corrections", "school_id = :school"], // my mishearings travel with the School
  ["parking_lot", "school_id = :school"],
  ["stickers", "classroom_id IN (SELECT id FROM classrooms WHERE school_id = :school)"],
  ["glossary_terms", "school_id = :school"],
  ["study_notes", "school_id = :school"],
  ["room_upgrades", "classroom_id IN (SELECT id FROM classrooms WHERE school_id = :school)"],
  ["trophies", "school_id = :school"],
  ["source_peeks", "school_id = :school"],
  [
    "diagrams",
    "period_id IN (SELECT p.id FROM periods p JOIN classrooms c ON c.id = p.classroom_id WHERE c.school_id = :school)",
  ],
  [
    "self_ratings",
    "concept_id IN (SELECT c.id FROM concepts c JOIN modules m ON m.id = c.module_id WHERE m.school_id = :school)",
  ],
  [
    "assets",
    `id IN (SELECT emblem_asset_id FROM schools WHERE id = :school)
     OR id IN (SELECT d.portrait_asset_id FROM cadets d JOIN classrooms c ON c.id = d.classroom_id WHERE c.school_id = :school)
     OR (owner_type = 'school' AND owner_id = :school)`,
  ],
];

interface Bundle {
  version: number;
  exportedAt: string;
  tables: Record<string, Array<Record<string, unknown>>>;
  vectors: { chunk: Array<[string, string]>; message: Array<[string, string]> };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "school";
const b64 = (buf: Uint8Array) => Buffer.from(buf).toString("base64");

export function exportSchool(
  handle: DbHandle,
  game: GameConfig,
  input: { schoolId: string; generatedDir: string },
): { filename: string; zip: Uint8Array } {
  const { sqlite } = handle;
  const school = sqlite.prepare("SELECT name FROM schools WHERE id = ?").get(input.schoolId) as
    { name: string } | undefined;
  if (!school) throw new Error("no such School");
  const tables: Bundle["tables"] = {};
  for (const [t, where] of TABLES)
    tables[t] = sqlite
      .prepare(`SELECT * FROM ${t} WHERE ${where}`)
      .all({ school: input.schoolId }) as Array<Record<string, unknown>>;
  const vec = (table: string, idCol: string, ids: string[]) =>
    ids.flatMap((id) => {
      const r = sqlite.prepare(`SELECT embedding FROM ${table} WHERE ${idCol} = ?`).get(id) as
        { embedding: Uint8Array } | undefined;
      return r ? [[id, b64(r.embedding)] as [string, string]] : [];
    });
  const bundle: Bundle = {
    version: VERSION,
    exportedAt: new Date().toISOString(),
    tables,
    vectors: {
      chunk: vec(
        "chunk_vec",
        "chunk_id",
        tables.chunks!.map((c) => String(c.id)),
      ),
      message: vec(
        "message_vec",
        "message_id",
        tables.messages!.filter((m) => m.speaker === "teacher").map((m) => String(m.id)),
      ),
    },
  };
  const root = `school-${slug(school.name)}`;
  const files: Record<string, Uint8Array> = {
    [`${root}/school.json`]: strToU8(JSON.stringify(bundle)),
    [`${root}/yearbook.md`]: strToU8(yearbookMarkdown(handle, game, input.schoolId)),
  };
  for (const s of tables.sources!) {
    const p = s.file_path as string | null;
    if (p && existsSync(p)) files[`${root}/sources/${basename(p)}`] = readFileSync(p);
  }
  for (const a of tables.assets!) {
    const p = a.file_path as string | null;
    if (p && existsSync(join(input.generatedDir, p)))
      files[`${root}/assets/${p}`] = readFileSync(join(input.generatedDir, p));
  }
  // Transcripts, one readable file per class period.
  const names = new Map(tables.cadets!.map((c) => [String(c.id), String(c.name)]));
  for (const p of tables.periods!) {
    const lines = tables
      .messages!.filter((m) => m.period_id === p.id)
      .map(
        (m) =>
          `**${m.speaker === "teacher" ? "Teacher" : (names.get(String(m.speaker)) ?? m.speaker)}:** ${String(m.text)}`,
      );
    if (lines.length)
      files[
        `${root}/transcripts/${String(p.started_at).slice(0, 16).replace(/[:T]/g, "-")}-${String(p.id)}.md`
      ] = strToU8(lines.join("\n\n") + "\n");
  }
  return { filename: `${root}.zip`, zip: zipSync(files, { level: 6 }) };
}

/**
 * Deletes an archived School for good: every row export would carry, its
 * vectors, its source files and its generated images. XP stays (my rank is
 * mine), and so does the cost log. Refuses a School that isn't archived.
 */
export function deleteSchool(
  handle: DbHandle,
  input: { schoolId: string; generatedDir: string },
): { name: string } {
  const { sqlite } = handle;
  const school = sqlite
    .prepare("SELECT name, archived FROM schools WHERE id = ?")
    .get(input.schoolId) as { name: string; archived: number } | undefined;
  if (!school) throw new Error("no such School");
  if (!school.archived) throw new Error("Archive the School first, then delete it from the shelf.");
  const p = { school: input.schoolId };
  const sources = sqlite
    .prepare("SELECT file_path AS f FROM sources WHERE school_id = :school")
    .all(p) as Array<{ f: string | null }>;
  // Images only this School uses (assets are shared by prompt).
  const assets = sqlite
    .prepare(
      `SELECT id, file_path AS f FROM assets WHERE (${TABLES.find(([t]) => t === "assets")![1]})
       AND id NOT IN (SELECT emblem_asset_id FROM schools WHERE id != :school AND emblem_asset_id IS NOT NULL)
       AND id NOT IN (SELECT d.portrait_asset_id FROM cadets d JOIN classrooms c ON c.id = d.classroom_id
                      WHERE c.school_id != :school AND d.portrait_asset_id IS NOT NULL)`,
    )
    .all(p) as Array<{ id: string; f: string | null }>;
  sqlite.transaction(() => {
    const cadets =
      "SELECT d.id FROM cadets d JOIN classrooms c ON c.id = d.classroom_id WHERE c.school_id = :school";
    sqlite.prepare(`DELETE FROM leak_events WHERE cadet_id IN (${cadets})`).run(p);
    sqlite
      .prepare(
        "DELETE FROM chunk_vec WHERE chunk_id IN (SELECT k.id FROM chunks k JOIN sources s ON s.id = k.source_id WHERE s.school_id = :school)",
      )
      .run(p);
    sqlite
      .prepare(
        `DELETE FROM message_vec WHERE message_id IN (SELECT m.id FROM messages m JOIN periods r ON r.id = m.period_id
         JOIN classrooms c ON c.id = r.classroom_id WHERE c.school_id = :school)`,
      )
      .run(p);
    const del = sqlite.prepare("DELETE FROM assets WHERE id = ?");
    for (const a of assets) del.run(a.id);
    // Children first: each table's rows are found through parents still present.
    for (const [t, where] of [...TABLES].reverse()) {
      if (t === "assets" || t === "xp_events") continue;
      sqlite.prepare(`DELETE FROM ${t} WHERE ${where}`).run(p);
    }
  })();
  for (const s of sources) if (s.f) rmSync(s.f, { force: true });
  for (const a of assets) if (a.f) rmSync(join(input.generatedDir, a.f), { force: true });
  return { name: school.name };
}

/** Restores an exported School. Refuses one that's already here (same id). */
export function importSchool(
  handle: DbHandle,
  input: { zip: Uint8Array; dataDir: string; generatedDir: string },
): { schoolId: string; name: string } {
  const files = unzipSync(input.zip);
  const jsonPath = Object.keys(files).find(
    (f) => f.endsWith("/school.json") || f === "school.json",
  );
  if (!jsonPath) throw new Error("That zip isn't a Lumen School export (no school.json).");
  const root = dirname(jsonPath);
  const bundle = JSON.parse(strFromU8(files[jsonPath]!)) as Bundle;
  if (!READS.includes(bundle.version))
    throw new Error(`Unsupported export version ${bundle.version}.`);
  const school = bundle.tables.schools?.[0];
  if (!school) throw new Error("The export has no School in it.");
  const { sqlite } = handle;
  if (sqlite.prepare("SELECT 1 FROM schools WHERE id = ?").get(school.id))
    throw new Error(`"${String(school.name)}" is already on this campus.`);
  if (sqlite.prepare("SELECT 1 FROM schools WHERE lower(name) = lower(?)").get(school.name))
    throw new Error(`A School called "${String(school.name)}" already exists here.`);

  // Files first: sources back into uploads/, images into generated/.
  const uploads = join(input.dataDir, "uploads");
  mkdirSync(uploads, { recursive: true });
  for (const s of bundle.tables.sources ?? []) {
    const p = s.file_path as string | null;
    const f = p ? files[`${root}/sources/${basename(p)}`] : undefined;
    if (p && f) {
      const dest = join(uploads, basename(p));
      writeFileSync(dest, f);
      s.file_path = dest;
    }
  }
  for (const a of bundle.tables.assets ?? []) {
    const p = a.file_path as string | null;
    const f = p ? files[`${root}/assets/${p}`] : undefined;
    if (p && f) {
      mkdirSync(dirname(join(input.generatedDir, p)), { recursive: true });
      writeFileSync(join(input.generatedDir, p), f);
    }
  }
  // Rows, in foreign-key order, in one transaction; the next free campus slot.
  const slot = (
    sqlite.prepare("SELECT coalesce(max(campus_slot), -1) + 1 AS n FROM schools").get() as {
      n: number;
    }
  ).n;
  school.campus_slot = slot;
  sqlite.transaction(() => {
    for (const [t] of TABLES) {
      for (const row of bundle.tables[t] ?? []) {
        const cols = Object.keys(row);
        if (
          t === "assets" &&
          sqlite
            .prepare("SELECT 1 FROM assets WHERE id = ? OR prompt_hash = ?")
            .get(row.id, row.prompt_hash)
        )
          continue;
        sqlite
          .prepare(
            `INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`,
          )
          .run(row);
      }
    }
    const putVec = (table: string, idCol: string, rows: Array<[string, string]>) => {
      const ins = sqlite.prepare(`INSERT INTO ${table} (${idCol}, embedding) VALUES (?, ?)`);
      for (const [id, data] of rows) ins.run(id, Buffer.from(data, "base64"));
    };
    putVec("chunk_vec", "chunk_id", bundle.vectors.chunk);
    putVec("message_vec", "message_id", bundle.vectors.message);
  })();
  return { schoolId: String(school.id), name: String(school.name) };
}
