import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { extname } from "node:path";
import { z } from "zod";
import { EditableCurriculumZ } from "@lumen/shared";
import {
  applyCurriculumEdit,
  CurriculumEditError,
  loadEditableCurriculum,
} from "../db/curriculumEdit.js";
import { schoolConceptStatuses } from "../game/schoolStatus.js";
import type { SourceKind } from "../ingest/parse.js";
import { ensureSchool } from "../ingest/pipeline.js";
import { join } from "node:path";
import { exportSchool, importSchool } from "../school/exportImport.js";
import { yearbookMarkdown } from "../school/yearbook.js";
import {
  addSource,
  generateCurriculum,
  generateEmblem,
  startRegistration,
  type JobDeps,
} from "../jobs.js";

// School setup REST (docs/05 §6): create a School, add sources, build and edit
// its curriculum, open Classrooms. Long work runs in the background and
// reports over WS (source.status, curriculum.status, registration.*).

const MAX_UPLOAD = 50 * 1024 * 1024;
const KINDS: Record<string, SourceKind> = {
  ".pdf": "pdf",
  ".md": "md",
  ".markdown": "md",
  ".txt": "txt",
};

const CreateSchoolZ = z.strictObject({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(400).optional(),
});
const PasteZ = z.strictObject({
  title: z.string().trim().min(1).max(120),
  text: z.string().trim().min(40).max(2_000_000),
});
const CreateClassroomZ = z.strictObject({
  difficulty: z.enum(["gentle", "standard", "ruthless"]).optional(),
});

export async function registerSchoolRoutes(app: FastifyInstance, deps: JobDeps) {
  const { sqlite } = deps.handle;
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD, files: 1 } });

  const school = (id: string) =>
    sqlite
      .prepare("SELECT id, name, description FROM schools WHERE id = ? AND archived = 0")
      .get(id) as { id: string; name: string; description: string | null } | undefined;

  app.post("/api/schools", async (req, reply) => {
    const body = CreateSchoolZ.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "Give the School a name (2–60 characters)." });
    const s = ensureSchool(deps.handle, body.data.name, body.data.description);
    if (!s.created)
      return reply.code(409).send({ error: "A School with that name already exists.", id: s.id });
    void generateEmblem(deps, s.id).catch(() => undefined); // S-4: never blocks creation
    return reply.code(201).send({ id: s.id });
  });

  // P-6: the Yearbook, your study notes from everything you taught.
  app.get<{ Params: { id: string } }>("/api/schools/:id/yearbook.md", async (req, reply) => {
    const s = school(req.params.id);
    if (!s) return reply.code(404).send({ error: "no such School" });
    return reply
      .header("content-type", "text/markdown; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="${s.name.replace(/[^\w -]/g, "")} yearbook.md"`,
      )
      .send(yearbookMarkdown(deps.handle, deps.game, s.id));
  });

  // O-5: the whole School as a zip, and back.
  app.get<{ Params: { id: string } }>("/api/schools/:id/export.zip", async (req, reply) => {
    const s = school(req.params.id);
    if (!s) return reply.code(404).send({ error: "no such School" });
    const { filename, zip } = exportSchool(deps.handle, deps.game, {
      schoolId: s.id,
      generatedDir: join(deps.dataDir, "generated"),
    });
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${filename}"`)
      .send(Buffer.from(zip));
  });

  app.post("/api/schools/import", async (req, reply) => {
    if (!req.isMultipart())
      return reply.code(400).send({ error: "Upload the School's .zip export." });
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "No file in the upload." });
    try {
      const r = importSchool(deps.handle, {
        zip: new Uint8Array(await file.toBuffer()),
        dataDir: deps.dataDir,
        generatedDir: join(deps.dataDir, "generated"),
      });
      return reply.code(201).send(r);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/schools/:id", async (req, reply) => {
    const s = school(req.params.id);
    if (!s) return reply.code(404).send({ error: "no such School" });
    const extra = sqlite
      .prepare(
        "SELECT emblem_asset_id AS emblemAssetId, accent_color AS accent FROM schools WHERE id = ?",
      )
      .get(s.id) as { emblemAssetId: string | null; accent: string | null };
    const emblemReady =
      extra.emblemAssetId &&
      (
        sqlite.prepare("SELECT status FROM assets WHERE id = ?").get(extra.emblemAssetId) as
          { status: string } | undefined
      )?.status === "ready";
    const sources = sqlite
      .prepare(
        "SELECT id, title, kind, status, error, page_count AS pageCount, created_at AS createdAt, (SELECT count(*) FROM chunks c WHERE c.source_id = s.id) AS chunks FROM sources s WHERE school_id = ? ORDER BY created_at",
      )
      .all(s.id);
    const classrooms = sqlite
      .prepare(
        `SELECT c.id, c.name, c.status, c.difficulty,
           (SELECT count(*) FROM cadets d WHERE d.classroom_id = c.id AND d.status IN ('enrolled','transferred_in','alumni')) AS cadets,
           (SELECT avg(l.comprehension) FROM ledger_entries l JOIN cadets d ON d.id = l.cadet_id
              WHERE d.classroom_id = c.id AND l.exposures > 0) AS understanding,
           (SELECT max(coalesce(p.ended_at, p.started_at)) FROM periods p WHERE p.classroom_id = c.id) AS lastPeriodAt,
           (SELECT count(*) FROM periods p WHERE p.classroom_id = c.id AND p.ended_at IS NOT NULL) AS periods
         FROM classrooms c WHERE c.school_id = ? AND c.status != 'archived' ORDER BY c.created_at`,
      )
      .all(s.id);
    return {
      ...s,
      accent: extra.accent,
      emblemUrl: emblemReady ? `/api/assets/${extra.emblemAssetId}` : null,
      sources,
      classrooms,
      classroomLimit: deps.game.classroomsPerSchool,
    };
  });

  app.post<{ Params: { id: string } }>("/api/schools/:id/sources", async (req, reply) => {
    const s = school(req.params.id);
    if (!s) return reply.code(404).send({ error: "no such School" });
    if (!deps.embedder)
      return reply.code(503).send({ error: "Indexing needs an OpenAI key in .env." });
    let input: { title: string; kind: SourceKind; data: Uint8Array | string };
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: "No file in the upload." });
      const kind = KINDS[extname(file.filename).toLowerCase()];
      if (!kind) return reply.code(415).send({ error: "Use a PDF, Markdown or text file." });
      const buf = await file.toBuffer();
      const title = file.filename.replace(/\.[^.]+$/, "");
      input = { title, kind, data: kind === "pdf" ? new Uint8Array(buf) : buf.toString("utf8") };
    } else {
      const body = PasteZ.safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ error: "Paste at least a paragraph, with a title." });
      input = { title: body.data.title, kind: "paste", data: body.data.text };
    }
    void addSource(deps, { schoolId: s.id, ...input });
    return reply.code(202).send({ accepted: true, title: input.title });
  });

  app.get<{ Params: { id: string; sid: string } }>(
    "/api/schools/:id/sources/:sid/status",
    async (req, reply) => {
      const row = sqlite
        .prepare("SELECT id, title, status, error FROM sources WHERE id = ? AND school_id = ?")
        .get(req.params.sid, req.params.id);
      return row ?? reply.code(404).send({ error: "no such source" });
    },
  );

  app.get<{ Params: { id: string } }>("/api/schools/:id/curriculum", async (req, reply) => {
    const s = school(req.params.id);
    if (!s) return reply.code(404).send({ error: "no such School" });
    return {
      ...loadEditableCurriculum(deps.handle, s.id),
      status: schoolConceptStatuses(deps.handle, s.id, deps.game.status),
    };
  });

  app.post<{ Params: { id: string } }>(
    "/api/schools/:id/curriculum/generate",
    async (req, reply) => {
      const s = school(req.params.id);
      if (!s) return reply.code(404).send({ error: "no such School" });
      if (!deps.embedder)
        return reply
          .code(503)
          .send({ error: "The Curriculum Architect needs an OpenAI key in .env." });
      const ready = sqlite
        .prepare("SELECT count(*) AS n FROM sources WHERE school_id = ? AND status = 'ready'")
        .get(s.id) as {
        n: number;
      };
      if (!ready.n)
        return reply
          .code(409)
          .send({ error: "Add a source and wait for it to finish indexing first." });
      void generateCurriculum(deps, s.id);
      return reply.code(202).send({ accepted: true });
    },
  );

  app.put<{ Params: { id: string } }>("/api/schools/:id/curriculum", async (req, reply) => {
    const s = school(req.params.id);
    if (!s) return reply.code(404).send({ error: "no such School" });
    const body = EditableCurriculumZ.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({
        error: "That curriculum isn't valid.",
        problems: body.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    try {
      return applyCurriculumEdit(deps.handle, s.id, body.data);
    } catch (err) {
      if (err instanceof CurriculumEditError)
        return reply.code(400).send({ error: "That edit can't be saved.", problems: err.problems });
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/api/schools/:id/classrooms", async (req, reply) => {
    const s = school(req.params.id);
    if (!s) return reply.code(404).send({ error: "no such School" });
    const body = CreateClassroomZ.safeParse(req.body ?? {});
    if (!body.success)
      return reply.code(400).send({ error: "Difficulty is gentle, standard or ruthless." });
    const concepts = sqlite
      .prepare(
        "SELECT count(*) AS n FROM concepts c JOIN modules m ON m.id = c.module_id WHERE m.school_id = ?",
      )
      .get(s.id) as { n: number };
    if (!concepts.n)
      return reply.code(409).send({ error: "Build the curriculum before opening a Classroom." });
    try {
      return reply
        .code(202)
        .send(await startRegistration(deps, { schoolId: s.id, difficulty: body.data.difficulty }));
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });
}
