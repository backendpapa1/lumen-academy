import type { DbHandle } from "../db/client.js";
import type { Embedder } from "../ingest/embed.js";

// Hybrid retrieval (docs/05 §7): score = 0.6 × cosine + 0.4 × bm25_norm,
// restricted to one school's ready sources, adjacent chunks deduped.

export interface SearchDeps {
  handle: DbHandle;
  embedder: Embedder;
}

export interface SearchQuery {
  query: string;
  schoolId: string;
  sourceId?: string;
  k?: number;
}

export interface SearchHit {
  chunkId: string;
  sourceId: string;
  ord: number;
  headingPath: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  text: string;
  score: number;
  cosine: number;
  bm25: number;
}

const W_COSINE = 0.6;
const W_BM25 = 0.4;
const CANDIDATES = 50;

/** FTS5 query from free text: quoted terms OR-ed, so punctuation can't break the syntax. */
export function ftsQuery(text: string): string | null {
  const terms = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
  return terms.length ? terms.map((t) => `"${t}"`).join(" OR ") : null;
}

interface ChunkRow {
  id: string;
  source_id: string;
  ord: number;
  heading_path: string | null;
  page_from: number | null;
  page_to: number | null;
  text: string;
}

export async function hybridSearch(deps: SearchDeps, q: SearchQuery): Promise<SearchHit[]> {
  const { sqlite } = deps.handle;
  const k = q.k ?? 8;
  const [queryVec] = await deps.embedder.embed([q.query]);
  if (!queryVec) return [];

  // Candidate pools. vec0 KNN is global, so over-fetch and filter by school below.
  const vecRows = sqlite
    .prepare(
      "SELECT chunk_id, distance FROM chunk_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance",
    )
    .all(queryVec, CANDIDATES) as { chunk_id: string; distance: number }[];
  const fts = ftsQuery(q.query);
  const ftsRows = fts
    ? (sqlite
        .prepare(
          `SELECT c.id AS chunk_id, bm25(chunk_fts) AS bm25 FROM chunk_fts f
           JOIN chunks c ON c.rowid = f.rowid WHERE chunk_fts MATCH ? ORDER BY bm25 LIMIT ?`,
        )
        .all(fts, CANDIDATES) as { chunk_id: string; bm25: number }[])
    : [];

  const ids = [...new Set([...vecRows.map((r) => r.chunk_id), ...ftsRows.map((r) => r.chunk_id)])];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");

  const rows = sqlite
    .prepare(
      `SELECT c.id, c.source_id, c.ord, c.heading_path, c.page_from, c.page_to, c.text
       FROM chunks c JOIN sources s ON s.id = c.source_id
       WHERE c.id IN (${placeholders}) AND s.school_id = ? AND s.status = 'ready'
       ${q.sourceId ? "AND s.id = ?" : ""}`,
    )
    .all(...ids, q.schoolId, ...(q.sourceId ? [q.sourceId] : [])) as ChunkRow[];
  if (!rows.length) return [];

  // Exact cosine for every candidate, including keyword-only ones.
  const distances = new Map(
    (
      sqlite
        .prepare(
          `SELECT chunk_id, vec_distance_cosine(embedding, ?) AS d FROM chunk_vec WHERE chunk_id IN (${rows.map(() => "?").join(",")})`,
        )
        .all(queryVec, ...rows.map((r) => r.id)) as { chunk_id: string; d: number }[]
    ).map((r) => [r.chunk_id, r.d]),
  );

  // bm25() is lower-is-better (negative); normalise to 0..1 with best = 1.
  const bm = new Map(ftsRows.map((r) => [r.chunk_id, r.bm25]));
  const present = rows.map((r) => bm.get(r.id)).filter((x): x is number => x !== undefined);
  const best = Math.min(...present);
  const worst = Math.max(...present);
  const bmNorm = (id: string) => {
    const v = bm.get(id);
    if (v === undefined) return 0;
    return worst === best ? 1 : (worst - v) / (worst - best);
  };

  const scored = rows
    .map((r) => {
      const cosine = 1 - (distances.get(r.id) ?? 1);
      const bm25 = bmNorm(r.id);
      return {
        chunkId: r.id,
        sourceId: r.source_id,
        ord: r.ord,
        headingPath: r.heading_path,
        pageFrom: r.page_from,
        pageTo: r.page_to,
        text: r.text,
        cosine,
        bm25,
        score: W_COSINE * cosine + W_BM25 * bm25,
      };
    })
    .sort((a, b) => b.score - a.score);

  // Neighbours in the same section share an 80-token overlap; keep only the
  // better of the pair. Chunks never overlap across headings, so those stay.
  const kept: SearchHit[] = [];
  for (const hit of scored) {
    const overlapsKept = kept.some(
      (h) =>
        h.sourceId === hit.sourceId &&
        Math.abs(h.ord - hit.ord) === 1 &&
        h.headingPath === hit.headingPath,
    );
    if (overlapsKept) continue;
    kept.push(hit);
    if (kept.length === k) break;
  }
  return kept;
}
