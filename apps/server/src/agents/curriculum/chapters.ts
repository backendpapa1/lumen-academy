import { existsSync, readFileSync } from "node:fs";
import { getDocumentProxy } from "unpdf";
import type { DbHandle } from "../../db/client.js";
import { headingsForPage, readPdfOutline } from "../../ingest/pdfOutline.js";

// A source split into chapters for the book-by-book curriculum. Chapters come
// from the source's headings; for a PDF indexed before PDF outlines were read,
// from the bookmarks in the stored file; otherwise from even-sized parts. Tiny
// chapters are merged, huge ones split, so each fits one careful reading.

export interface ChapterChunk {
  id: string;
  text: string;
  page: number | null;
}

export interface Chapter {
  title: string;
  /** "pp. 11–24", when pages are known. */
  pages: string | null;
  chunks: ChapterChunk[];
  /** Front or back matter, by its title: not read. */
  skip: string | null;
}

/** Chunks per chapter part, and characters, at most (one careful reading each). */
const MAX_CHUNKS = 36;
const MAX_CHARS = 60_000;
const MIN_CHARS = 2_500;
/** Captions sections titled only by a timestamp ("12:40") aren't chapters. */
const TIMESTAMP = /^\d{1,2}:\d{2}(:\d{2})?$/;
const MATTER =
  /^(contents|table of contents|index|copyright|acknowledg(e)?ments?|about the authors?|dedication|colophon|imprint|bibliography|references|further reading|list of (figures|tables))\b/i;

interface Row {
  id: string;
  heading_path: string | null;
  page_from: number | null;
  text: string;
}

export async function chaptersFor(
  handle: DbHandle,
  source: { id: string; kind: string; filePath: string | null; title: string },
): Promise<Chapter[]> {
  const rows = handle.sqlite
    .prepare(
      "SELECT id, heading_path, page_from, text FROM chunks WHERE source_id = ? ORDER BY ord",
    )
    .all(source.id) as Row[];
  if (!rows.length) return [];

  // The heading each chunk belongs to, at the level that gives sensible chapters.
  let paths = rows.map((r) => (r.heading_path ? r.heading_path.split(" > ").filter(Boolean) : []));
  if (
    paths.every((p) => !p.length) &&
    source.kind === "pdf" &&
    source.filePath &&
    existsSync(source.filePath)
  ) {
    try {
      const pdf = await getDocumentProxy(new Uint8Array(readFileSync(source.filePath)));
      const outline = await readPdfOutline(pdf, 2);
      if (outline.length)
        paths = rows.map((r) => (r.page_from ? headingsForPage(outline, r.page_from) : []));
    } catch {
      /* no outline: even parts below */
    }
  }
  paths = paths.map((p) => p.filter((h) => !TIMESTAMP.test(h.trim())));
  const level = chooseLevel(paths);
  const keyOf = (p: string[]) => p.slice(0, level + 1).join(" › ") || null;

  // Consecutive chunks under the same heading form a chapter.
  let groups: Array<{ title: string | null; rows: Row[] }> = [];
  rows.forEach((r, i) => {
    const key = keyOf(paths[i]!);
    const last = groups.at(-1);
    if (last && last.title === key) last.rows.push(r);
    else groups.push({ title: key, rows: [r] });
  });
  if (groups.every((g) => !g.title)) {
    // No headings at all: even parts (a single part keeps the source's own name).
    groups = [];
    for (let i = 0; i < rows.length; i += 24)
      groups.push({ title: `Part ${groups.length + 1}`, rows: rows.slice(i, i + 24) });
    if (groups.length === 1) groups[0]!.title = null;
  } else if (!groups[0]!.title && groups[0]!.rows.length <= 4) {
    // Untitled pages before the first heading: a cover and title pages.
    groups[0]!.title = "Front matter";
  }

  // Merge tiny groups into the next (or the previous, at the end).
  const chars = (g: { rows: Row[] }) => g.rows.reduce((n, r) => n + r.text.length, 0);
  const merged: typeof groups = [];
  for (const g of groups) {
    const prev = merged.at(-1);
    if (
      prev &&
      (chars(prev) < MIN_CHARS || prev.rows.length < 2) &&
      !MATTER.test(prev.title ?? "") &&
      prev.title
    ) {
      prev.rows.push(...g.rows);
      prev.title = g.title ?? prev.title;
    } else merged.push({ ...g, rows: [...g.rows] });
  }
  if (merged.length > 1 && chars(merged.at(-1)!) < MIN_CHARS) {
    const tail = merged.pop()!;
    merged.at(-1)!.rows.push(...tail.rows);
  }

  // Split huge ones into parts.
  const out: Chapter[] = [];
  for (const g of merged) {
    const parts: Row[][] = [[]];
    for (const r of g.rows) {
      const cur = parts.at(-1)!;
      if (
        cur.length >= MAX_CHUNKS ||
        (cur.length && chars({ rows: cur }) + r.text.length > MAX_CHARS)
      )
        parts.push([r]);
      else cur.push(r);
    }
    const base = (g.title ?? source.title).split(" › ").at(-1)!;
    parts.forEach((p, i) => {
      const pages = p.map((r) => r.page_from).filter((n): n is number => n !== null);
      out.push({
        title: parts.length > 1 ? `${base} (part ${i + 1} of ${parts.length})` : base,
        pages: pages.length
          ? pages[0] === pages.at(-1)
            ? `p. ${pages[0]}`
            : `pp. ${pages[0]}–${pages.at(-1)}`
          : null,
        chunks: p.map((r) => ({ id: r.id, text: r.text, page: r.page_from })),
        skip: MATTER.test(base.trim()) || base === "Front matter" ? "front or back matter" : null,
      });
    });
  }
  return out;
}

/**
 * Which heading level makes the chapters: the top level, unless it's just a
 * few "parts" (Part I, Part II…), then the level below.
 */
function chooseLevel(paths: string[][]): number {
  const distinct = (lvl: number) => new Set(paths.map((p) => p[lvl]).filter(Boolean)).size;
  const top = distinct(0);
  return top > 0 && top <= 3 && paths.length > 60 && distinct(1) >= 4 ? 1 : 0;
}

/** About how many concepts a chapter deserves: denser chapters get more. */
export function targetConcepts(ch: Chapter): number {
  const chars = ch.chunks.reduce((n, c) => n + c.text.length, 0);
  return Math.max(2, Math.min(8, Math.round(chars / 5_000)));
}
