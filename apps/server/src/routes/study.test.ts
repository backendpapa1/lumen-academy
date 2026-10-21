import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { agentOf, fakeDeepSeekFactory } from "../test-fixtures/fakeDeepSeek.js";
import { smallWorld } from "../test-fixtures/world.js";
import { UsageMeter } from "../usage/meter.js";

const cfg = loadConfig({ env: {} });
let app: FastifyInstance | undefined;
let h: DbHandle | undefined;
afterEach(async () => {
  await app?.close();
  h?.close();
});

async function boot(reply: (agent: string | undefined) => string = () => "{}") {
  const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
  h = w.handle;
  const meter = new UsageMeter({ db: h.db, pricing: cfg.pricing, budget: cfg.models.budget });
  const { factory } = fakeDeepSeekFactory(cfg.models, (body) => reply(agentOf(body)), { meter });
  app = await buildApp({
    config: cfg,
    dataDir: mkdtempSync(join(tmpdir(), "lumen-study-")),
    runtime: { handle: h, factory, meter, game: cfg.game },
  });
  return { w, app };
}

describe("study session (Paul's note)", () => {
  it("lists the School's sources, reads one as text, and keeps a notebook", async () => {
    const { w, app } = await boot();
    const sid = (w.handle.sqlite.prepare("SELECT id FROM sources").get() as { id: string }).id;
    w.handle.sqlite.prepare("UPDATE sources SET status = 'ready' WHERE id = ?").run(sid);
    const study = (
      await app.inject({ method: "GET", url: `/api/schools/${w.schoolId}/study` })
    ).json<{
      sources: Array<{ id: string; original: boolean }>;
      notes: { body: string; updatedAt: string | null };
    }>();
    expect(study.sources.map((s) => s.id)).toEqual([sid]);
    expect(study.notes).toEqual({ body: "", updatedAt: null });

    const text = (
      await app.inject({ method: "GET", url: `/api/schools/${w.schoolId}/sources/${sid}/text` })
    ).json<{ sections: Array<{ text: string }> }>();
    expect(text.sections.length).toBeGreaterThan(0);

    const put = await app.inject({
      method: "PUT",
      url: `/api/schools/${w.schoolId}/study/notes`,
      payload: { body: "# Merkle trees\nPairs hash up to one root." },
    });
    expect(put.statusCode).toBe(200);
    const again = (
      await app.inject({ method: "GET", url: `/api/schools/${w.schoolId}/study` })
    ).json<{
      notes: { body: string };
    }>();
    expect(again.notes.body).toBe("# Merkle trees\nPairs hash up to one root.");
  });

  it("serves a PDF original inline, and nothing for another School's source", async () => {
    const { w, app } = await boot();
    const sid = (w.handle.sqlite.prepare("SELECT id FROM sources").get() as { id: string }).id;
    const pdf = join(mkdtempSync(join(tmpdir(), "lumen-pdf-")), "a.pdf");
    writeFileSync(pdf, "%PDF-1.4 fake");
    w.handle.sqlite
      .prepare("UPDATE sources SET status = 'ready', kind = 'pdf', file_path = ? WHERE id = ?")
      .run(pdf, sid);
    const res = await app.inject({
      method: "GET",
      url: `/api/schools/${w.schoolId}/sources/${sid}/file`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/^inline/);
    expect(
      (await app.inject({ method: "GET", url: `/api/schools/sch_other/sources/${sid}/file` }))
        .statusCode,
    ).toBe(404);
  });
});

describe("study hall: prepare for class (Paul: improve the study hall)", () => {
  const json = async <T>(
    app: FastifyInstance,
    method: "GET" | "POST" | "PATCH" | "PUT",
    url: string,
    payload?: object,
  ) => {
    const r = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    return { status: r.statusCode, body: r.json<T>() };
  };

  it("preps the next concept with its passages, chapters, a question, and a checked answer", async () => {
    const { w, app } = await boot((agent) =>
      agent === "explanationCoach"
        ? JSON.stringify({
            verdict: "partly",
            covered: ["Merkle Trees a", "made-up fact"],
            missed: ["Merkle Trees b"],
            wrong: null,
            studentReply: "So pairs get hashed, but where does the root go?",
            tip: "Say where the root ends up.",
          })
        : "{}",
    );
    const sid = (w.handle.sqlite.prepare("SELECT id FROM sources").get() as { id: string }).id;
    w.handle.sqlite.prepare("UPDATE sources SET status = 'ready' WHERE id = ?").run(sid);

    const study = await json<{
      prep: Array<{
        classroomName: string;
        concept: { title: string };
        why: string;
        passages: unknown[];
      }>;
      classmates: Array<{ name: string }>;
      todayMinutes: number;
    }>(app, "GET", `/api/schools/${w.schoolId}/study`);
    expect(study.body.prep).toHaveLength(1);
    expect(study.body.prep[0]).toMatchObject({ classroomName: "Class A", why: "next" });
    expect(study.body.prep[0]!.concept.title).toBe("Merkle Trees");
    expect(study.body.prep[0]!.passages.length).toBeGreaterThan(0);
    expect(study.body.classmates.map((c) => c.name)).toEqual(["Cadet 0"]);

    // Chapters, with a reading time; mark one read.
    const ch = await json<{
      chapters: Array<{ key: string; title: string; minutes: number; read: boolean }>;
    }>(app, "GET", `/api/schools/${w.schoolId}/sources/${sid}/chapters`);
    expect(ch.body.chapters.length).toBeGreaterThan(0);
    const key = ch.body.chapters[0]!.key;
    await json(app, "PUT", `/api/schools/${w.schoolId}/sources/${sid}/chapters/${key}/read`, {
      read: true,
    });
    const ch2 = await json<{ chapters: Array<{ read: boolean }> }>(
      app,
      "GET",
      `/api/schools/${w.schoolId}/sources/${sid}/chapters`,
    );
    expect(ch2.body.chapters[0]!.read).toBe(true);

    // A student leans over, about a concept cited by what I'm reading.
    const chunk = (
      w.handle.sqlite.prepare("SELECT id FROM chunks ORDER BY ord").get() as { id: string }
    ).id;
    const q = await json<{
      question: { concept: { id: string; title: string }; cadet: { id: string }; text: string };
    }>(app, "GET", `/api/schools/${w.schoolId}/study/question?chunks=${chunk}`);
    expect(q.body.question.text).toContain(q.body.question.concept.title);
    const ans = await json<{ check: { covered: string[]; studentReply: string }; xp: number }>(
      app,
      "POST",
      `/api/schools/${w.schoolId}/study/explain`,
      {
        conceptId: q.body.question.concept.id,
        kind: "answer",
        cadetId: q.body.question.cadet.id,
        question: q.body.question.text,
        text: "Pairs of hashes get hashed together until one is left.",
      },
    );
    expect(ans.status).toBe(200);
    // Only facts from the concept's list count.
    expect(ans.body.check.covered).toEqual(["Merkle Trees a"]);
    expect(ans.body.xp).toBe(cfg.game.xp.studyAnswer);

    // A quote of that passage is tied to its concept.
    const quote = await json<{ concept: { title: string } | null }>(
      app,
      "POST",
      `/api/schools/${w.schoolId}/study/quotes`,
      {
        text: "Pairs are hashed up to a root.",
        sourceId: sid,
        chunkId: chunk,
        page: null,
      },
    );
    expect(quote.body.concept?.title).toBe("Merkle Trees");
    const notes = await json<{ quotes: unknown[]; explanations: unknown[] }>(
      app,
      "GET",
      `/api/schools/${w.schoolId}/study/concepts/${q.body.question.concept.id}`,
    );
    expect(notes.body.quotes).toHaveLength(1);
    expect(notes.body.explanations).toHaveLength(1);
  });

  it("a long-enough session keeps the streak and earns XP once; the intention's outcome is kept", async () => {
    const { w, app } = await boot();
    const start = await json<{ id: string }>(app, "POST", "/api/study/sessions", {
      schoolId: w.schoolId,
      intention: "Read chapter 4",
    });
    const url = `/api/study/sessions/${start.body.id}`;
    await json(app, "PATCH", url, { minutes: 6 });
    const end = await json<{
      xp: number;
      streak: number;
      countsForStreak: boolean;
      todayMinutes: number;
    }>(app, "PATCH", url, { minutes: cfg.game.study.streakMinutes, end: true, outcome: "partly" });
    expect(end.body).toMatchObject({
      xp: cfg.game.xp.studyMinute! * cfg.game.study.streakMinutes,
      streak: 1,
      countsForStreak: true,
      todayMinutes: cfg.game.study.streakMinutes,
    });
    const again = await json<{ xp: number }>(app, "PATCH", url, { end: true });
    expect(again.body.xp).toBe(0);
    const row = w.handle.sqlite.prepare("SELECT intention, outcome FROM study_sessions").get();
    expect(row).toEqual({ intention: "Read chapter 4", outcome: "partly" });
  });

  it("explains a failed check plainly and still saves the explanation", async () => {
    const { w, app } = await boot(() => "not json");
    const r = await app.inject({
      method: "POST",
      url: `/api/schools/${w.schoolId}/study/explain`,
      payload: {
        conceptId: w.conceptIds[0],
        kind: "rehearse",
        cadetId: null,
        question: null,
        text: "A Merkle tree hashes pairs.",
      },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json<{ error: string }>().error).toMatch(/saved, but I couldn't check it/);
    expect(w.handle.sqlite.prepare("SELECT count(*) n FROM study_explanations").get()).toEqual({
      n: 1,
    });
  });
});
