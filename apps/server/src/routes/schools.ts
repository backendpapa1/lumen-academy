import { parseExamDate, studyPlan } from "../game/studyPlan.js";
import { dayIn } from "../game/campus.js";
import { glossaryFor } from "../speech/glossary.js";
import { captionsToSource, fetchYouTube, youtubeId } from "../ingest/sources/youtube.js";
import { fetchArticle } from "../ingest/sources/web.js";
import { ocrImage, OCR_TYPES } from "../ingest/sources/ocr.js";
import type { ParsedSource } from "../ingest/parse.js";
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
import { deleteSchool, exportSchool, importSchool } from "../school/exportImport.js";
import { yearbookMarkdown } from "../school/yearbook.js";
import { knowledgeMarkdown, knowledgeReport } from "../school/knowledge.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { callStructured } from "../agents/harness.js";
import { loadPrompt } from "../agents/prompts/load.js";
import {
  addSource,
  extendCurriculum,
  generateCurriculum,
  generateEmblem,
  sourcesOutsideCurriculum,
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
  ".pptx": "pptx",
  ".apkg": "anki",
};

const CreateSchoolZ = z.strictObject({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(400).optional(),
});
const PasteZ = z.strictObject({
  title: z.string().trim().min(1).max(120),
  text: z.string().trim().min(40).max(2_000_000),
  /** V6-04: text read from a photo of notes, corrected by me. */
  kind: z.enum(["paste", "notes"]).default("paste"),
});
const LinkZ = z.strictObject({ url: z.string().trim().min(4).max(2000) });

/** V6-01/02: a fetched source as Markdown, so it's stored and re-parsed like any other. */
const toMarkdown = (p: ParsedSource) =>
  p.sections
    .map(
      (s) => `${s.headingPath.map((h, i) => `${"#".repeat(i + 1)} ${h}`).join("\n")}\n\n${s.text}`,
    )
    .join("\n\n");
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
    if (!s.created) {
      const gone = sqlite.prepare("SELECT archived FROM schools WHERE id = ?").get(s.id) as {
        archived: number;
      };
      return reply.code(409).send({
        error: gone.archived
          ? "An archived School has that name. Restore it from Archived on the lobby."
          : "A School with that name already exists.",
        id: s.id,
      });
    }
    void generateEmblem(deps, s.id).catch(() => undefined); // S-4: never blocks creation
    return reply.code(201).send({ id: s.id });
  });

  // P-6: the Yearbook, your study notes from everything you taught.
  // S-4: draw the emblem again (e.g. in the new style); the old one shows until it lands.
  app.post<{ Params: { id: string } }>("/api/schools/:id/emblem", async (req, reply) => {
    if (!school(req.params.id)) return reply.code(404).send({ error: "no such School" });
    if (!deps.assets) return reply.code(503).send({ error: "Image generation isn't set up." });
    void generateEmblem(deps, req.params.id).catch(() => undefined);
    return reply.code(202).send({ ok: true });
  });

  // Archive puts a School away (off the lobby and the campus) without deleting
  // anything; restore brings it back exactly as it was.
  app.get("/api/schools/archived", async () =>
    sqlite
      .prepare(
        `SELECT s.id, s.name, s.accent_color AS accent,
           (SELECT count(*) FROM concepts c JOIN modules m ON m.id = c.module_id WHERE m.school_id = s.id) AS concepts,
           (SELECT count(*) FROM classrooms c WHERE c.school_id = s.id AND c.status != 'archived') AS classrooms
         FROM schools s WHERE s.archived = 1 ORDER BY s.name COLLATE NOCASE`,
      )
      .all(),
  );
  for (const [verb, value] of [
    ["archive", 1],
    ["restore", 0],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/api/schools/:id/${verb}`, async (req, reply) => {
      const r = sqlite
        .prepare("UPDATE schools SET archived = ? WHERE id = ? AND archived = ?")
        .run(value, req.params.id, 1 - value);
      if (!r.changes) return reply.code(404).send({ error: "no such School" });
      return { ok: true };
    });
  }

  // Delete for good, only from the Archived shelf, with the School's name typed to confirm.
  const DeleteZ = z.object({ name: z.string() });
  app.post<{ Params: { id: string } }>("/api/schools/:id/delete", async (req, reply) => {
    const row = sqlite
      .prepare("SELECT name, archived FROM schools WHERE id = ?")
      .get(req.params.id) as { name: string; archived: number } | undefined;
    if (!row) return reply.code(404).send({ error: "no such School" });
    if (!row.archived)
      return reply
        .code(409)
        .send({ error: "Archive the School first, then delete it from the shelf." });
    const body = DeleteZ.safeParse(req.body);
    if (!body.success || body.data.name.trim().toLowerCase() !== row.name.trim().toLowerCase())
      return reply
        .code(400)
        .send({ error: `Type the School's name, “${row.name}”, to delete it.` });
    deleteSchool(deps.handle, {
      schoolId: req.params.id,
      generatedDir: join(deps.dataDir, "generated"),
    });
    return { ok: true, name: row.name };
  });

  // V2-07/08: "What I actually know", from the evidence, with my own ratings beside it.
  app.get<{ Params: { id: string } }>("/api/schools/:id/knowledge", async (req, reply) => {
    const r = school(req.params.id) && knowledgeReport(deps.handle, deps.game, req.params.id);
    return r || reply.code(404).send({ error: "no such School" });
  });
  app.get<{ Params: { id: string } }>("/api/schools/:id/knowledge.md", async (req, reply) => {
    const r = school(req.params.id) && knowledgeReport(deps.handle, deps.game, req.params.id);
    if (!r) return reply.code(404).send({ error: "no such School" });
    const name = r.school.name.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase();
    return reply
      .type("text/markdown; charset=utf-8")
      .header("content-disposition", `attachment; filename="${name}-what-i-know.md"`)
      .send(knowledgeMarkdown(r));
  });
  const SummaryZ = z.object({ summary: z.string().min(10).max(1200) });
  app.post<{ Params: { id: string } }>("/api/schools/:id/knowledge/summary", async (req, reply) => {
    const r = school(req.params.id) && knowledgeReport(deps.handle, deps.game, req.params.id);
    if (!r) return reply.code(404).send({ error: "no such School" });
    const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);
    const rows = r.concepts
      .map(
        (c) =>
          `- ${c.title} | ${c.status} | ${pct(c.peak)} → ${pct(c.now)} | ${c.turns.toFixed(1)} | ${c.openMistakes.length} | ${c.selfRating ?? "–"}`,
      )
      .join("\n");
    try {
      const res = await callStructured(deps.factory, "knowledgeReporter", {
        schema: SummaryZ,
        name: "knowledge_summary",
        messages: [
          new SystemMessage(loadPrompt("knowledgeReporter", { schoolName: r.school.name, rows })),
          new HumanMessage("Write the summary."),
        ],
      });
      return { summary: res.data.summary };
    } catch {
      return reply
        .code(502)
        .send({ error: "The summary didn't come through. The evidence below still stands." });
    }
  });
  const RatingZ = z.strictObject({ rating: z.number().int().min(1).max(5).nullable() });
  app.put<{ Params: { id: string } }>("/api/concepts/:id/self-rating", async (req, reply) => {
    const body = RatingZ.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "A rating is 1 to 5." });
    if (!sqlite.prepare("SELECT 1 FROM concepts WHERE id = ?").get(req.params.id))
      return reply.code(404).send({ error: "no such concept" });
    if (body.data.rating === null)
      sqlite.prepare("DELETE FROM self_ratings WHERE concept_id = ?").run(req.params.id);
    else
      sqlite
        .prepare(
          `INSERT INTO self_ratings (concept_id, rating, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (concept_id) DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at`,
        )
        .run(req.params.id, body.data.rating, new Date().toISOString());
    return { ok: true };
  });

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
      if (!kind)
        return reply.code(415).send({
          error: OCR_TYPES.has(extname(file.filename).toLowerCase())
            ? "Photos go through “Photo of notes”, so you can check the text first."
            : "Use a PDF, slides (.pptx), an Anki deck (.apkg), Markdown or a text file.",
        });
      const buf = await file.toBuffer();
      const title = file.filename.replace(/\.[^.]+$/, "");
      const binary = kind === "pdf" || kind === "pptx" || kind === "anki";
      input = { title, kind, data: binary ? new Uint8Array(buf) : buf.toString("utf8") };
    } else {
      const body = PasteZ.safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ error: "Paste at least a paragraph, with a title." });
      input = { title: body.data.title, kind: body.data.kind, data: body.data.text };
    }
    void addSource(deps, { schoolId: s.id, ...input });
    return reply.code(202).send({ accepted: true, title: input.title });
  });

  /**
   * V6-01/02: a pasted link. YouTube gets its public captions (no video), any
   * other page its readable article. The only network use is this one URL.
   */
  app.post<{ Params: { id: string } }>("/api/schools/:id/sources/link", async (req, reply) => {
    const s = school(req.params.id);
    if (!s) return reply.code(404).send({ error: "no such School" });
    if (!deps.embedder)
      return reply.code(503).send({ error: "Indexing needs an OpenAI key in .env." });
    const body = LinkZ.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Paste a link." });
    try {
      const { url } = body.data;
      if (youtubeId(url)) {
        const yt = await fetchYouTube(url);
        const title = `${yt.title}${yt.auto ? " (auto-captions)" : ""}`;
        void addSource(deps, {
          schoolId: s.id,
          title,
          kind: "youtube",
          data: toMarkdown(yt.parsed),
          url: yt.url,
        });
        return reply.code(202).send({ accepted: true, title, kind: "youtube" });
      }
      const web = await fetchArticle(url);
      void addSource(deps, {
        schoolId: s.id,
        title: web.title,
        kind: "web",
        data: toMarkdown(web.parsed),
        url: web.url,
      });
      return reply.code(202).send({ accepted: true, title: web.title, kind: "web" });
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message });
    }
  });

  /**
   * V6-01 fallback: a talk with no captions, uploaded as audio and transcribed on
   * this machine (local Whisper). It becomes a source with "12:40" anchors.
   */
  app.post<{ Params: { id: string } }>("/api/schools/:id/sources/audio", async (req, reply) => {
    const s = school(req.params.id);
    if (!s) return reply.code(404).send({ error: "no such School" });
    if (!deps.embedder)
      return reply.code(503).send({ error: "Indexing needs an OpenAI key in .env." });
    const stt = deps.speech?.stt;
    if (!stt?.transcribeLong || stt.status() === "missing")
      return reply.code(503).send({
        error:
          "Transcribing needs local Whisper (see Settings › Voice). It isn't set up on this machine.",
      });
    if (!req.isMultipart()) return reply.code(400).send({ error: "Upload an audio file." });
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "No audio in the upload." });
    if (!/\.(mp3|m4a|wav|ogg|oga|opus|webm|flac|aac)$/i.test(file.filename))
      return reply.code(415).send({ error: "Use an audio file: MP3, M4A, WAV, OGG or WebM." });
    const audio = await file.toBuffer();
    const title = file.filename.replace(/\.[^.]+$/, "");
    deps.bus.emit({
      type: "source.status",
      payload: {
        schoolId: s.id,
        sourceId: null,
        title,
        status: "parsing",
        detail: "transcribing on this computer",
      },
    });
    const glossary = glossaryFor(deps.handle, s.id, 600);
    void stt
      .transcribeLong(audio, file.filename, glossary)
      .then((lines) =>
        addSource(deps, {
          schoolId: s.id,
          title,
          kind: "notes",
          data: toMarkdown(captionsToSource(lines)),
        }),
      )
      .catch((err: Error) =>
        deps.bus.emit({
          type: "source.status",
          payload: { schoolId: s.id, sourceId: null, title, status: "error", detail: err.message },
        }),
      );
    return reply.code(202).send({ accepted: true, title });
  });

  /** V6-07: "I have an exam on Friday". A date, a weekday or "in 5 days"; null clears it. */
  const GoalZ = z.strictObject({ when: z.string().trim().max(40).nullable() });
  app.put<{ Params: { id: string } }>("/api/schools/:id/goal", async (req, reply) => {
    const s = school(req.params.id);
    if (!s) return reply.code(404).send({ error: "no such School" });
    const body = GoalZ.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "When is the exam?" });
    if (body.data.when === null) {
      sqlite.prepare("UPDATE schools SET exam_date = NULL WHERE id = ?").run(s.id);
      return { plan: null };
    }
    const today = dayIn(deps.game.streak.timezone, new Date());
    const date = parseExamDate(body.data.when, today);
    if (!date)
      return reply.code(400).send({ error: 'Try a date, a weekday ("Friday") or "in 5 days".' });
    if (date < today) return reply.code(400).send({ error: "That date has passed." });
    if (Date.parse(date) - Date.parse(today) > 366 * 86_400_000)
      return reply.code(400).send({ error: "Pick a date within the next year." });
    sqlite.prepare("UPDATE schools SET exam_date = ? WHERE id = ?").run(date, s.id);
    return { plan: studyPlan(deps.handle, deps.game, s.id) };
  });

  app.get<{ Params: { id: string } }>("/api/schools/:id/plan", async (req, reply) => {
    const s = school(req.params.id);
    if (!s) return reply.code(404).send({ error: "no such School" });
    return { plan: studyPlan(deps.handle, deps.game, s.id) };
  });

  /** V6-04: read a photo of notes on this machine; I correct the text before it's ingested. */
  app.post<{ Params: { id: string } }>("/api/schools/:id/ocr", async (req, reply) => {
    if (!school(req.params.id)) return reply.code(404).send({ error: "no such School" });
    if (!req.isMultipart()) return reply.code(400).send({ error: "Upload a photo." });
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "No photo in the upload." });
    const ext = extname(file.filename).toLowerCase();
    if (!OCR_TYPES.has(ext))
      return reply.code(415).send({
        error:
          ext === ".heic" || ext === ".heif"
            ? "HEIC photos can't be read yet. Share it from your phone as JPEG."
            : "Use a JPG or PNG photo.",
      });
    try {
      const r = await ocrImage(new Uint8Array(await file.toBuffer()));
      if (!r.text) return reply.code(422).send({ error: "No text found in that photo." });
      return { ...r, title: file.filename.replace(/\.[^.]+$/, "") };
    } catch (err) {
      return reply.code(500).send({ error: `Reading the photo failed: ${(err as Error).message}` });
    }
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
      // S-5: sources added after the curriculum was built.
      newSources: sourcesOutsideCurriculum(deps.handle, s.id),
    };
  });

  app.post<{ Params: { id: string } }>("/api/schools/:id/curriculum/extend", async (req, reply) => {
    const s = school(req.params.id);
    if (!s) return reply.code(404).send({ error: "no such School" });
    if (!deps.embedder)
      return reply
        .code(503)
        .send({ error: "The Curriculum Architect needs an OpenAI key in .env." });
    if (!sourcesOutsideCurriculum(deps.handle, s.id).length)
      return reply.code(409).send({ error: "Every source is already in the curriculum." });
    void extendCurriculum(deps, s.id).catch(() => undefined);
    return reply.code(202).send({ accepted: true });
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
