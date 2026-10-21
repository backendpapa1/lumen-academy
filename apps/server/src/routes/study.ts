import { createReadStream, existsSync } from "node:fs";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ExplanationCheckZ, type GameConfig } from "@lumen/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { chaptersFor } from "../agents/curriculum/chapters.js";
import { callStructured } from "../agents/harness.js";
import { loadPrompt } from "../agents/prompts/load.js";
import type { DbHandle } from "../db/client.js";
import { newId } from "../db/ids.js";
import { streak } from "../game/campus.js";
import {
  buddyQuestion,
  classmatesFor,
  conceptById,
  conceptsAround,
  lookupsFor,
  markLookedUp,
  passagesFor,
  prepFor,
  studyMinutesToday,
} from "../game/studyHall.js";
import { awardXp } from "../game/xp.js";
import type { ModelFactory } from "../models/factory.js";

// The study session (Paul's note): read my own sources in the study hall,
// the original PDF or the text the School indexed, and keep one study
// notebook per School beside them. Only for me: students never see these.

const NotesZ = z.strictObject({ body: z.string().max(200_000) });
const SessionZ = z.strictObject({
  schoolId: z.string().nullable(),
  intention: z.string().trim().max(200).nullable(),
});
const SessionUpdateZ = z.strictObject({
  minutes: z.number().int().min(0).max(600).optional(),
  outcome: z.enum(["done", "partly", "not"]).optional(),
  end: z.boolean().optional(),
});
const QuoteZ = z.strictObject({
  text: z.string().trim().min(1).max(4000),
  sourceId: z.string().nullable(),
  chunkId: z.string().nullable(),
  page: z.number().int().nullable(),
});
const ExplainZ = z.strictObject({
  conceptId: z.string(),
  kind: z.enum(["rehearse", "answer"]),
  cadetId: z.string().nullable(),
  question: z.string().max(300).nullable(),
  text: z.string().trim().min(3).max(3000),
});

/** Why the coach couldn't answer, in plain words. */
function whyNoCheck(err: unknown): string {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/budget|cap reached|over the monthly/.test(m))
    return "you've reached your monthly budget cap (raise it in Settings).";
  if (/401|403|unauthori[sz]ed|api key|is not set \(needed for/.test(m))
    return "DeepSeek needs a working API key (API keys and settings).";
  if (/fetch failed|enotfound|econnrefused|econnreset|network|eai_again/.test(m))
    return "DeepSeek can't be reached. Check your internet connection.";
  if (/429|rate limit/.test(m)) return "DeepSeek is busy. Try again in a minute.";
  return "the coach didn't answer. Try again in a moment.";
}

/** A chapter in the reader: where it starts, how long, whether I finished it. */
interface ReaderChapter {
  key: string;
  title: string;
  pages: string | null;
  firstPage: number | null;
  firstChunkId: string;
  chunkIds: string[];
  minutes: number;
  skip: boolean;
}

/** Kinds whose original file the browser can show as is. */
const INLINE: Record<string, string> = { pdf: "application/pdf" };

export function registerStudyRoutes(
  app: FastifyInstance,
  deps: { handle: DbHandle; game: GameConfig; factory: ModelFactory },
) {
  const { handle, game } = deps;
  const { sqlite } = handle;
  const schoolExists = (id: string) =>
    !!sqlite.prepare("SELECT 1 FROM schools WHERE id = ?").get(id);
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
    return {
      school: s,
      sources,
      notes: { body: notes?.body ?? "", updatedAt: notes?.at ?? null },
      prep: prepFor(handle, game, s.id),
      lookups: lookupsFor(handle, s.id),
      classmates: classmatesFor(handle, s.id),
      todayMinutes: studyMinutesToday(handle, game),
      settings: {
        breakMinutes: game.study.breakMinutes,
        longStudyMinutes: game.study.longStudyMinutes,
        interruptEveryMinutes: game.study.interruptEveryMinutes,
      },
    };
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
          "SELECT id, text, heading_path h, page_from p FROM chunks WHERE source_id = ? ORDER BY ord",
        )
        .all(s.id) as Array<{ id: string; text: string; h: string | null; p: number | null }>;
      return {
        id: s.id,
        title: s.title,
        kind: s.kind,
        url: s.url,
        sections: chunks.map((c) => ({ id: c.id, heading: c.h, page: c.p, text: c.text })),
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

  // --- chapters: read a chapter at a time ------------------------------------------

  const chapterCache = new Map<string, { n: number; chapters: ReaderChapter[] }>();
  const chaptersOf = async (schoolId: string, sid: string): Promise<ReaderChapter[] | null> => {
    const s = source(schoolId, sid);
    if (!s) return null;
    const n = (
      sqlite.prepare("SELECT count(*) n FROM chunks WHERE source_id = ?").get(sid) as {
        n: number;
      }
    ).n;
    const hit = chapterCache.get(sid);
    if (hit && hit.n === n) return hit.chapters;
    const chapters = (
      await chaptersFor(handle, { id: s.id, kind: s.kind, filePath: s.f, title: s.title })
    ).map((c) => {
      const chars = c.chunks.reduce((k, x) => k + x.text.length, 0);
      return {
        key: c.chunks[0]!.id,
        title: c.title,
        pages: c.pages,
        firstPage: c.chunks.find((x) => x.page !== null)?.page ?? null,
        firstChunkId: c.chunks[0]!.id,
        chunkIds: c.chunks.map((x) => x.id),
        minutes: Math.max(1, Math.round(chars / game.study.readingCharsPerMinute)),
        skip: !!c.skip,
      };
    });
    chapterCache.set(sid, { n, chapters });
    return chapters;
  };

  app.get<{ Params: { id: string; sid: string } }>(
    "/api/schools/:id/sources/:sid/chapters",
    async (req, reply) => {
      const chapters = await chaptersOf(req.params.id, req.params.sid);
      if (!chapters) return reply.code(404).send({ error: "no such source" });
      const read = new Set(
        (
          sqlite
            .prepare("SELECT chapter_key k FROM study_reads WHERE school_id = ? AND source_id = ?")
            .all(req.params.id, req.params.sid) as Array<{ k: string }>
        ).map((r) => r.k),
      );
      return { chapters: chapters.map((c) => ({ ...c, read: read.has(c.key) })) };
    },
  );

  app.put<{ Params: { id: string; sid: string; key: string } }>(
    "/api/schools/:id/sources/:sid/chapters/:key/read",
    async (req, reply) => {
      const body = z.strictObject({ read: z.boolean() }).safeParse(req.body);
      if (!body.success || !source(req.params.id, req.params.sid))
        return reply.code(400).send({ error: "Mark which chapter?" });
      if (body.data.read)
        sqlite
          .prepare(
            "INSERT OR IGNORE INTO study_reads (school_id, source_id, chapter_key, read_at) VALUES (?, ?, ?, ?)",
          )
          .run(req.params.id, req.params.sid, req.params.key, new Date().toISOString());
      else
        sqlite
          .prepare(
            "DELETE FROM study_reads WHERE school_id = ? AND source_id = ? AND chapter_key = ?",
          )
          .run(req.params.id, req.params.sid, req.params.key);
      return { ok: true };
    },
  );

  // --- sessions: an intention, focused minutes, and the check at the bell ----------

  app.post("/api/study/sessions", async (req, reply) => {
    const body = SessionZ.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Start a study session how?" });
    if (body.data.schoolId && !schoolExists(body.data.schoolId))
      return reply.code(404).send({ error: "no such School" });
    const id = newId("studySession");
    sqlite
      .prepare(
        "INSERT INTO study_sessions (id, school_id, started_at, minutes, intention) VALUES (?, ?, ?, 0, ?)",
      )
      .run(id, body.data.schoolId, new Date().toISOString(), body.data.intention || null);
    return { id };
  });

  app.patch<{ Params: { sid: string } }>("/api/study/sessions/:sid", async (req, reply) => {
    const body = SessionUpdateZ.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Update the session how?" });
    const row = sqlite
      .prepare("SELECT school_id school, minutes, xp_awarded xp FROM study_sessions WHERE id = ?")
      .get(req.params.sid) as { school: string | null; minutes: number; xp: number } | undefined;
    if (!row) return reply.code(404).send({ error: "no such session" });
    const minutes = Math.max(row.minutes, body.data.minutes ?? 0);
    sqlite
      .prepare(
        "UPDATE study_sessions SET minutes = ?, outcome = coalesce(?, outcome), ended_at = CASE WHEN ? THEN ? ELSE ended_at END WHERE id = ?",
      )
      .run(
        minutes,
        body.data.outcome ?? null,
        body.data.end ? 1 : 0,
        new Date().toISOString(),
        req.params.sid,
      );
    let xp = 0;
    if (body.data.end && !row.xp && minutes > 0 && row.school) {
      xp = awardXp(
        handle,
        game,
        { schoolId: row.school, classroomId: null, periodId: null },
        "studyMinute",
        minutes,
      );
      sqlite.prepare("UPDATE study_sessions SET xp_awarded = 1 WHERE id = ?").run(req.params.sid);
    }
    return {
      minutes,
      xp,
      todayMinutes: studyMinutesToday(handle, game),
      streak: streak(handle, game).current,
      countsForStreak: minutes >= game.study.streakMinutes,
    };
  });

  // --- prep: passages, look-ups, quotes ---------------------------------------------

  app.get<{ Params: { id: string; cid: string }; Querystring: { ifAny?: string } }>(
    "/api/schools/:id/study/concepts/:cid",
    async (req, reply) => {
      const concept = conceptById(handle, req.params.id, req.params.cid);
      // The classroom only asks whether there are notes: none is an answer, not an error.
      if (!concept && req.query.ifAny)
        return { concept: null, passages: [], quotes: [], explanations: [] };
      if (!concept) return reply.code(404).send({ error: "no such concept" });
      return {
        concept,
        passages: passagesFor(handle, concept.id, 12),
        quotes: sqlite
          .prepare(
            "SELECT q.id, q.text, q.page, s.title source FROM study_quotes q LEFT JOIN sources s ON s.id = q.source_id WHERE q.concept_id = ? ORDER BY q.created_at DESC LIMIT 20",
          )
          .all(concept.id),
        explanations: (
          sqlite
            .prepare(
              "SELECT id, kind, question, text, check_json c, created_at at FROM study_explanations WHERE concept_id = ? ORDER BY created_at DESC LIMIT 10",
            )
            .all(concept.id) as Array<Record<string, unknown> & { c: string | null }>
        ).map(({ c, ...e }) => ({ ...e, check: c ? (JSON.parse(c) as unknown) : null })),
      };
    },
  );

  app.post<{ Params: { id: string; lid: string } }>(
    "/api/schools/:id/study/lookups/:lid/done",
    async (req, reply) => {
      if (!schoolExists(req.params.id)) return reply.code(404).send({ error: "no such School" });
      markLookedUp(handle, req.params.id, req.params.lid);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>("/api/schools/:id/study/quotes", async (req, reply) => {
    const body = QuoteZ.safeParse(req.body);
    if (!body.success || !schoolExists(req.params.id))
      return reply.code(400).send({ error: "Quote what?" });
    // The concept its passage teaches, if the curriculum cites it.
    const concept = body.data.chunkId
      ? (sqlite
          .prepare(
            `SELECT c.id, c.title FROM concept_citations cc JOIN concepts c ON c.id = cc.concept_id
             JOIN modules m ON m.id = c.module_id WHERE cc.chunk_id = ? AND m.school_id = ? LIMIT 1`,
          )
          .get(body.data.chunkId, req.params.id) as { id: string; title: string } | undefined)
      : undefined;
    const id = newId("studyQuote");
    sqlite
      .prepare(
        "INSERT INTO study_quotes (id, school_id, concept_id, source_id, chunk_id, text, page, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        req.params.id,
        concept?.id ?? null,
        body.data.sourceId,
        body.data.chunkId,
        body.data.text,
        body.data.page,
        new Date().toISOString(),
      );
    return { id, concept: concept ?? null };
  });

  // --- a student leans over; the Explanation Coach -------------------------------------

  app.get<{ Params: { id: string }; Querystring: { chunks?: string; conceptId?: string } }>(
    "/api/schools/:id/study/question",
    async (req, reply) => {
      if (!schoolExists(req.params.id)) return reply.code(404).send({ error: "no such School" });
      const recent = new Set(
        (
          sqlite
            .prepare(
              "SELECT concept_id c FROM study_explanations WHERE school_id = ? AND created_at > ?",
            )
            .all(req.params.id, new Date(Date.now() - 86_400_000).toISOString()) as Array<{
            c: string;
          }>
        ).map((r) => r.c),
      );
      const around = req.query.conceptId
        ? [req.query.conceptId]
        : conceptsAround(
            handle,
            req.params.id,
            (req.query.chunks ?? "").split(",").filter(Boolean),
          );
      const pick = around.find((c) => !recent.has(c)) ?? around[0];
      const concept = pick ? conceptById(handle, req.params.id, pick) : null;
      if (!concept) return { question: null };
      const mates = classmatesFor(handle, req.params.id, 6);
      const seed = Date.now() >> 10;
      const cadet = mates.length ? mates[seed % mates.length]! : null;
      return {
        question: {
          concept: { id: concept.id, title: concept.title },
          cadet,
          text: buddyQuestion(cadet?.archetype ?? "", concept.title, seed),
        },
      };
    },
  );

  app.post<{ Params: { id: string } }>("/api/schools/:id/study/explain", async (req, reply) => {
    const body = ExplainZ.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Explain what?" });
    const concept = conceptById(handle, req.params.id, body.data.conceptId);
    if (!concept) return reply.code(404).send({ error: "no such concept" });
    const cadet = body.data.cadetId
      ? (sqlite
          .prepare("SELECT name, archetype FROM cadets WHERE id = ?")
          .get(body.data.cadetId) as { name: string; archetype: string } | undefined)
      : undefined;
    const id = newId("studyExplanation");
    const save = (check: unknown) =>
      sqlite
        .prepare(
          "INSERT INTO study_explanations (id, school_id, concept_id, kind, cadet_id, question, text, check_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          req.params.id,
          concept.id,
          body.data.kind,
          body.data.cadetId,
          body.data.question,
          body.data.text,
          check ? JSON.stringify(check) : null,
          new Date().toISOString(),
        );
    const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)");
    try {
      const res = await callStructured(deps.factory, "explanationCoach", {
        schema: ExplanationCheckZ,
        name: "explanation_check",
        messages: [
          new SystemMessage(
            loadPrompt("explanationCoach", {
              title: concept.title,
              summary: concept.summary,
              keyFacts: list(concept.keyFacts),
              misconceptions: list(concept.misconceptions),
              student: cadet ? `${cadet.name} (${cadet.archetype})` : "a fellow student",
              question:
                body.data.kind === "answer" && body.data.question
                  ? `The student asked: "${body.data.question}"`
                  : "The teacher is rehearsing the explanation before class.",
            }),
          ),
          new HumanMessage(`The teacher's explanation:\n${body.data.text}`),
        ],
      });
      // Only facts from the list count; the coach may not invent any.
      const facts = new Set(concept.keyFacts);
      const check = {
        ...res.data,
        covered: res.data.covered.filter((f) => facts.has(f)),
        missed: res.data.missed.filter((f) => facts.has(f)),
      };
      save(check);
      const xp = awardXp(
        handle,
        game,
        { schoolId: req.params.id, classroomId: null, periodId: null },
        "studyAnswer",
      );
      return { id, check, keyFacts: concept.keyFacts, xp };
    } catch (err) {
      save(null);
      return reply.code(503).send({
        id,
        error: `Your explanation is saved, but I couldn't check it: ${whyNoCheck(err)}`,
      });
    }
  });
}
