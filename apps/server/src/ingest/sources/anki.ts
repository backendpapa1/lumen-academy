import Database from "better-sqlite3";
import { unzipSync } from "fflate";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedSource, Section } from "../parse.js";

// Anki decks (V6-05): an .apkg is a zip holding a SQLite collection. Each note's
// fields (front, back, …) become one chunk; its first tag (else its deck) is the
// heading. Newer exports compress the collection (anki21b, zstd): those ask
// for an export with "Support older Anki versions" ticked.

/** Anki separates a note's fields (and nested deck names) with the unit separator. */
const FIELD_SEP = String.fromCharCode(0x1f);

const strip = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\[sound:[^\]]+\]/g, "")
    .replace(/\{\{c\d+::([^}]*?)(::[^}]*)?\}\}/g, "$1") // cloze → its answer
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

export function parseAnki(bytes: Uint8Array): ParsedSource {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("That .apkg file couldn't be opened.");
  }
  const name = files["collection.anki21"]
    ? "collection.anki21"
    : files["collection.anki2"]
      ? "collection.anki2"
      : null;
  if (!name)
    throw new Error(
      files["collection.anki21b"]
        ? 'This deck uses the newest Anki format. Export it again with "Support older Anki versions" ticked.'
        : "No Anki collection found in that file.",
    );
  const dir = mkdtempSync(join(tmpdir(), "lumen-anki-"));
  const path = join(dir, "collection.sqlite");
  writeFileSync(path, files[name]!);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const decks = new Map<string, string>();
    try {
      const row = db.prepare("SELECT decks FROM col").get() as { decks: string } | undefined;
      for (const d of Object.values(
        JSON.parse(row?.decks ?? "{}") as Record<string, { id: number; name: string }>,
      ))
        decks.set(String(d.id), d.name.split(FIELD_SEP).join(" › "));
    } catch {
      /* newer collections keep decks in their own table */
      try {
        for (const d of db.prepare("SELECT id, name FROM decks").all() as Array<{
          id: number;
          name: string;
        }>)
          decks.set(String(d.id), d.name.split(FIELD_SEP).join(" › "));
      } catch {
        /* no deck names: tags or "Cards" will do */
      }
    }
    const notes = db
      .prepare(
        `SELECT n.id, n.flds, n.tags, (SELECT c.did FROM cards c WHERE c.nid = n.id LIMIT 1) AS did
         FROM notes n ORDER BY n.id`,
      )
      .all() as Array<{ id: number; flds: string; tags: string; did: number | null }>;
    const sections: Section[] = [];
    for (const n of notes) {
      const fields = n.flds.split(FIELD_SEP).map(strip).filter(Boolean);
      if (!fields.length) continue;
      const tag = n.tags
        .trim()
        .split(/\s+/)
        .filter(Boolean)[0]
        ?.replace(/::/g, " › ")
        .replace(/_/g, " ");
      const heading = tag ?? decks.get(String(n.did)) ?? "Cards";
      const [front, ...rest] = fields;
      sections.push({
        headingPath: [heading],
        text: rest.length ? `Q: ${front}\nA: ${rest.join("\n")}` : front!,
      });
    }
    if (!sections.length) throw new Error("That deck has no cards with text.");
    const headings = [...new Set(sections.map((s) => s.headingPath[0]!))];
    return { sections, outline: headings.map((title) => ({ title, depth: 1 })) };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
