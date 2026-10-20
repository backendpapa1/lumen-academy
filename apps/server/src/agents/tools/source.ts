import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { DbHandle } from "../../db/client.js";
import type { Embedder } from "../../ingest/embed.js";
import { hybridSearch } from "../../retrieval/search.js";

// Source tools for deep agents (Curriculum Architect, Examiner, Grader).
// Cadets never get these (knowledge gating, docs/03 §6).

export interface SourceToolDeps {
  handle: DbHandle;
  embedder: Embedder;
  schoolId: string;
}

const label = (h: { headingPath: string | null; pageFrom: number | null; pageTo: number | null }) =>
  [
    h.headingPath,
    h.pageFrom
      ? `p.${h.pageFrom}${h.pageTo && h.pageTo !== h.pageFrom ? `–${h.pageTo}` : ""}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

export function sourceTools(deps: SourceToolDeps) {
  const searchSource = tool(
    async ({ query, sourceId, k }) => {
      const hits = await hybridSearch(deps, { query, schoolId: deps.schoolId, sourceId, k });
      if (!hits.length) return "No matching chunks.";
      return hits.map((h) => `[${h.chunkId}] (${label(h)})\n${h.text}`).join("\n\n---\n\n");
    },
    {
      name: "search_source",
      description:
        "Hybrid (semantic + keyword) search over this School's sources. Returns chunk ids with their text. Cite chunk ids.",
      schema: z.object({
        query: z.string().describe("What to look for"),
        sourceId: z.string().optional().describe("Limit to one source"),
        k: z.number().int().min(1).max(20).default(8),
      }),
    },
  );

  const readChunks = tool(
    async ({ ids }) => {
      const rows = deps.handle.sqlite
        .prepare(
          `SELECT c.id, c.heading_path, c.page_from, c.page_to, c.text FROM chunks c JOIN sources s ON s.id = c.source_id
           WHERE s.school_id = ? AND c.id IN (${ids.map(() => "?").join(",")}) ORDER BY c.source_id, c.ord`,
        )
        .all(deps.schoolId, ...ids) as {
        id: string;
        heading_path: string | null;
        page_from: number | null;
        page_to: number | null;
        text: string;
      }[];
      if (!rows.length) return "No chunks with those ids in this School.";
      return rows
        .map(
          (r) =>
            `[${r.id}] (${label({ headingPath: r.heading_path, pageFrom: r.page_from, pageTo: r.page_to })})\n${r.text}`,
        )
        .join("\n\n---\n\n");
    },
    {
      name: "read_chunks",
      description: "Read the full text of specific chunks by id.",
      schema: z.object({ ids: z.array(z.string()).min(1).max(20) }),
    },
  );

  const getSourceOutline = tool(
    async ({ sourceId }) => {
      const src = deps.handle.sqlite
        .prepare("SELECT title, outline_json FROM sources WHERE id = ? AND school_id = ?")
        .get(sourceId, deps.schoolId) as { title: string; outline_json: string | null } | undefined;
      if (!src) return "No such source in this School.";
      const chunkIndex = deps.handle.sqlite
        .prepare("SELECT id, ord, heading_path FROM chunks WHERE source_id = ? ORDER BY ord")
        .all(sourceId) as { id: string; ord: number; heading_path: string | null }[];
      const outline = (JSON.parse(src.outline_json ?? "[]") as { title: string; depth: number }[])
        .map((o) => `${"  ".repeat(o.depth - 1)}- ${o.title}`)
        .join("\n");
      const index = chunkIndex
        .map((c) => `${c.id}  ${c.heading_path ?? "(no heading)"}`)
        .join("\n");
      return `# ${src.title}\n\nOutline:\n${outline || "(none)"}\n\nChunks (${chunkIndex.length}):\n${index}`;
    },
    {
      name: "get_source_outline",
      description: "Headings of a source plus the list of its chunk ids by section.",
      schema: z.object({ sourceId: z.string() }),
    },
  );

  return {
    searchSource,
    readChunks,
    getSourceOutline,
    all: [searchSource, readChunks, getSourceOutline],
  };
}
