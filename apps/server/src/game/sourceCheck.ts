import type { DbHandle } from "../db/client.js";
import { newId } from "../db/ids.js";
import type { Embedder } from "../ingest/embed.js";
import { hybridSearch } from "../retrieval/search.js";

// /source (V6-06): checking myself in class. The passage of MY sources that
// best matches what I just said, with its reference. Mine only: students
// never see it. Each look is logged, and an exam set soon after is marked
// open-book (honest records beat a flattering score).

/** An exam created within this long after a peek counts as open-book. */
export const OPEN_BOOK_MS = 60 * 60_000;

export interface SourcePassage {
  query: string;
  text: string;
  source: string;
  heading: string;
  page: number | null;
  url: string | null;
}

export async function checkSource(
  deps: { handle: DbHandle; embedder: Embedder },
  input: { schoolId: string; periodId: string | null; query: string },
): Promise<SourcePassage | null> {
  const hits = await hybridSearch(deps, { schoolId: input.schoolId, query: input.query, k: 1 });
  const hit = hits[0];
  deps.handle.sqlite
    .prepare(
      "INSERT INTO source_peeks (id, school_id, period_id, query, chunk_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      newId("peek"),
      input.schoolId,
      input.periodId,
      input.query.slice(0, 500),
      hit?.chunkId ?? null,
      new Date().toISOString(),
    );
  if (!hit) return null;
  const src = deps.handle.sqlite
    .prepare("SELECT title, url FROM sources WHERE id = ?")
    .get(hit.sourceId) as { title: string; url: string | null };
  return {
    query: input.query,
    text: hit.text,
    source: src.title,
    heading: hit.headingPath ?? "",
    page: hit.pageFrom,
    url: src.url,
  };
}

/** True if I peeked at this School's sources in the last hour. */
export function peekedRecently(handle: DbHandle, schoolId: string, now = Date.now()): boolean {
  return !!handle.sqlite
    .prepare("SELECT 1 FROM source_peeks WHERE school_id = ? AND created_at >= ? LIMIT 1")
    .get(schoolId, new Date(now - OPEN_BOOK_MS).toISOString());
}
