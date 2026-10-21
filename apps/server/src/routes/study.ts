import { createReadStream, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DbHandle } from "../db/client.js";

// The study session (Paul's note): read my own sources in the study hall,
// the original PDF or the text the School indexed, and keep one study
// notebook per School beside them. Only for me: students never see these.

const NotesZ = z.strictObject({ body: z.string().max(200_000) });

/** Kinds whose original file the browser can show as is. */
const INLINE: Record<string, string> = { pdf: "application/pdf" };

export function registerStudyRoutes(app: FastifyInstance, handle: DbHandle) {
  const { sqlite } = handle;
  const source = (schoolId: string, sid: string) =>
    sqlite
      .prepare(
        "SELECT id, title, kind, url, file_path f, page_count pages FROM sources WHERE id = ? AND school_id = ? AND status = 'ready'",
      )
      .get(sid, schoolId) as
      | {
          id: string;
          title: string;
          kind: string;
          url: string | null;
          f: string | null;
          pages: number | null;
        }
      | undefined;

  /** The School's readable sources, for the reader's picker. */
  app.get<{ Params: { id: string } }>("/api/schools/:id/study", async (req, reply) => {
    const s = sqlite.prepare("SELECT id, name FROM schools WHERE id = ?").get(req.params.id) as
      { id: string; name: string } | undefined;
    if (!s) return reply.code(404).send({ error: "no such School" });
    const sources = (
      sqlite
        .prepare(
          "SELECT id, title, kind, url, file_path f, page_count pages FROM sources WHERE school_id = ? AND status = 'ready' ORDER BY created_at",
        )
        .all(s.id) as Array<{
        id: string;
        title: string;
        kind: string;
        url: string | null;
        f: string | null;
        pages: number | null;
      }>
    ).map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      url: r.url,
      pages: r.pages,
      // The original opens in the browser's own viewer; everything else reads as text.
      original: !!INLINE[r.kind] && !!r.f && existsSync(r.f),
    }));
    const notes = sqlite
      .prepare("SELECT body, updated_at at FROM study_notes WHERE school_id = ?")
      .get(s.id) as { body: string; at: string } | undefined;
    return { school: s, sources, notes: { body: notes?.body ?? "", updatedAt: notes?.at ?? null } };
  });

  /** The original file (a PDF), shown inline in the reader. */
  app.get<{ Params: { id: string; sid: string } }>(
    "/api/schools/:id/sources/:sid/file",
    async (req, reply) => {
      const s = source(req.params.id, req.params.sid);
      const type = s && INLINE[s.kind];
      if (!s || !type || !s.f || !existsSync(s.f))
        return reply.code(404).send({ error: "no such file" });
      return reply
        .type(type)
        .header("content-disposition", `inline; filename="${encodeURIComponent(s.title)}.pdf"`)
        .header("cache-control", "private, max-age=3600")
        .send(createReadStream(s.f));
    },
  );

  /** The text the School indexed, in order with its headings and pages. */
  app.get<{ Params: { id: string; sid: string } }>(
    "/api/schools/:id/sources/:sid/text",
    async (req, reply) => {
      const s = source(req.params.id, req.params.sid);
      if (!s) return reply.code(404).send({ error: "no such source" });
      const chunks = sqlite
        .prepare(
          "SELECT text, heading_path h, page_from p FROM chunks WHERE source_id = ? ORDER BY ord",
        )
        .all(s.id) as Array<{ text: string; h: string | null; p: number | null }>;
      return {
        id: s.id,
        title: s.title,
        kind: s.kind,
        url: s.url,
        sections: chunks.map((c) => ({ heading: c.h, page: c.p, text: c.text })),
      };
    },
  );

  app.put<{ Params: { id: string } }>("/api/schools/:id/study/notes", async (req, reply) => {
    if (!sqlite.prepare("SELECT 1 FROM schools WHERE id = ?").get(req.params.id))
      return reply.code(404).send({ error: "no such School" });
    const body = NotesZ.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Those notes are too long to save." });
    const at = new Date().toISOString();
    sqlite
      .prepare(
        "INSERT INTO study_notes (school_id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(school_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
      )
      .run(req.params.id, body.data.body, at);
    return { updatedAt: at };
  });
}
