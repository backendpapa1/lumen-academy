import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import type { SpeechConfig } from "@lumen/shared";
import { fixTranscript } from "../agents/realtime/transcriptFixer.js";
import { knownMishearings, recordCorrections } from "../speech/corrections.js";
import type { DbHandle } from "../db/client.js";
import type { ModelFactory } from "../models/factory.js";
import { glossaryFor } from "../speech/glossary.js";
import type { Speaker } from "../speech/tts.js";
import type { Transcriber } from "../speech/stt.js";
import { registerOf } from "../game/looks.js";
import { pickVoice, type StudentVoice } from "../speech/voices.js";
import type { UsageMeter } from "../usage/meter.js";

// Voice (V1-01..05): my speech in, students' speech out. Both run on this
// machine (VD1–VD3). Recordings are transcribed in memory and never stored.

export interface SpeechRuntime {
  cfg: SpeechConfig;
  stt: Transcriber;
  tts: Speaker;
}

const MAX_AUDIO = 10 * 1024 * 1024; // ~10 min of opus; a push-to-talk clip is tiny
const SayZ = z.strictObject({
  cadetId: z.string().min(1),
  text: z.string().trim().min(1).max(500),
});

export async function registerSpeechRoutes(
  app: FastifyInstance,
  deps: { handle: DbHandle; meter: UsageMeter; factory: ModelFactory; speech: SpeechRuntime },
) {
  const { sqlite } = deps.handle;
  const { speech } = deps;
  if (!app.hasContentTypeParser("multipart/form-data"))
    await app.register(multipart, { limits: { fileSize: MAX_AUDIO, files: 1 } });

  // The glossary is the same for a whole class; keep it for a minute.
  const glossaries = new Map<string, { at: number; text: string }>();
  const glossary = (classroomId: string) => {
    const row = sqlite
      .prepare("SELECT school_id AS s FROM classrooms WHERE id = ?")
      .get(classroomId) as { s: string } | undefined;
    if (!row) return "";
    const hit = glossaries.get(row.s);
    if (hit && Date.now() - hit.at < 60_000) return hit.text;
    const text = glossaryFor(deps.handle, row.s, speech.cfg.stt.glossaryChars);
    glossaries.set(row.s, { at: Date.now(), text });
    return text;
  };

  app.get("/api/speech/status", async () => ({
    stt: speech.stt.status(),
    tts: speech.tts.status(),
    sttProblem: speech.stt.problem,
    ttsProblem: speech.tts.problem,
  }));

  const CorrectionZ = z.strictObject({
    classroomId: z.string().min(1),
    suggested: z.string().trim().min(1).max(2000),
    sent: z.string().trim().min(1).max(2000),
  });
  /** I edited the recogniser's words before sending: learn the swaps for this School. */
  app.post("/api/speech/corrections", async (req, reply) => {
    const body = CorrectionZ.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "What changed?" });
    const row = sqlite
      .prepare("SELECT school_id AS s FROM classrooms WHERE id = ?")
      .get(body.data.classroomId) as { s: string } | undefined;
    if (!row) return reply.code(404).send({ error: "no such classroom" });
    const learned = recordCorrections(deps.handle, row.s, body.data.suggested, body.data.sent);
    if (learned.length) glossaries.delete(row.s);
    return { learned };
  });

  const FixZ = z.strictObject({
    classroomId: z.string().min(1),
    text: z.string().trim().min(1).max(2000),
  });
  /** Second step for the lectern: fix what was heard (it shows the raw words meanwhile). */
  app.post("/api/speech/fix", async (req, reply) => {
    const body = FixZ.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Fix what?" });
    const t = performance.now();
    const text = await fixTranscript(deps.factory, {
      text: body.data.text,
      glossary: glossary(body.data.classroomId),
      ...lessonContext(body.data.classroomId),
    }).catch(() => body.data.text);
    return { text, fixMs: Math.round(performance.now() - t) };
  });

  app.post<{ Querystring: { classroomId?: string; fix?: string } }>(
    "/api/speech/transcribe",
    async (req, reply) => {
      if (speech.stt.problem) return reply.code(503).send({ error: speech.stt.problem });
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: "No audio was sent." });
      const audio = await file.toBuffer();
      if (audio.length < 800) return { text: "", ms: 0 }; // a click, not speech
      try {
        const prompt = req.query.classroomId ? glossary(req.query.classroomId) : "";
        const r = await speech.stt.transcribe(audio, file.mimetype, prompt);
        deps.meter.record({ agent: "stt", provider: "local", model: "whisper", latencyMs: r.ms });
        let text = r.text;
        let fixMs = 0;
        if (text && speech.cfg.stt.correct && req.query.classroomId && req.query.fix !== "0") {
          const t = performance.now();
          text = await fixTranscript(deps.factory, {
            text,
            glossary: prompt,
            ...lessonContext(req.query.classroomId),
          }).catch(() => r.text); // the fix is a nicety: what was heard still goes
          fixMs = performance.now() - t;
        }
        return { text, heard: r.text, ms: Math.round(r.ms), fixMs: Math.round(fixMs) };
      } catch (e) {
        req.log.warn({ err: e }, "transcription failed");
        return reply.code(502).send({ error: "I couldn't hear that. Try again, or type it." });
      }
    },
  );

  /** A student's line as audio, in their own voice (picked once and kept). */
  app.post("/api/speech/say", async (req, reply) => {
    if (speech.tts.problem) return reply.code(503).send({ error: speech.tts.problem });
    const body = SayZ.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Say what, and who says it?" });
    const voice = voiceOf(body.data.cadetId);
    if (!voice) return reply.code(404).send({ error: "no such student" });
    try {
      const r = await speech.tts.say(body.data.text, voice.voice, voice.speed);
      deps.meter.record({ agent: "tts", provider: "local", model: "kokoro", latencyMs: r.ms });
      return reply.type("audio/wav").header("x-voice", voice.voice).send(r.wav);
    } catch (e) {
      req.log.warn({ err: e }, "speech failed");
      return reply.code(502).send({ error: "That student lost their voice for a moment." });
    }
  });

  /** The School, the concept on the board, and my last two lines in this class. */
  function lessonContext(classroomId: string) {
    const room = sqlite
      .prepare(
        `SELECT s.name AS school, c.title AS concept FROM classrooms r JOIN schools s ON s.id = r.school_id
         LEFT JOIN concepts c ON c.id = r.current_concept_id WHERE r.id = ?`,
      )
      .get(classroomId) as { school: string; concept: string | null } | undefined;
    const recent = (
      sqlite
        .prepare(
          `SELECT m.text FROM messages m JOIN periods p ON p.id = m.period_id
           WHERE p.classroom_id = ? AND m.speaker = 'teacher' AND m.kind IN ('lecture','answer')
           ORDER BY m.created_at DESC, m.rowid DESC LIMIT 2`,
        )
        .all(classroomId) as Array<{ text: string }>
    )
      .map((r) => r.text)
      .reverse();
    const school = sqlite
      .prepare("SELECT school_id AS s FROM classrooms WHERE id = ?")
      .get(classroomId) as { s: string } | undefined;
    return {
      schoolName: room?.school ?? "",
      conceptTitle: room?.concept ?? "",
      recent,
      mishearings: school ? knownMishearings(deps.handle, school.s) : [],
    };
  }

  function voiceOf(cadetId: string): StudentVoice | null {
    const row = sqlite
      .prepare(
        "SELECT id, archetype, classroom_id AS room, voice_json AS v, traits_json AS t FROM cadets WHERE id = ?",
      )
      .get(cadetId) as
      { id: string; archetype: string; room: string; v: string | null; t: string } | undefined;
    if (!row) return null;
    const register = registerOf(row.id, row.t);
    if (row.v) {
      try {
        const kept = JSON.parse(row.v) as StudentVoice;
        // A voice picked before the register fitted the name is re-picked.
        if (speech.cfg.tts.voices[register].includes(kept.voice)) return kept;
      } catch {
        /* re-pick below */
      }
    }
    const taken = (
      sqlite
        .prepare(
          "SELECT voice_json AS v FROM cadets WHERE classroom_id = ? AND id != ? AND voice_json IS NOT NULL",
        )
        .all(row.room, row.id) as Array<{ v: string }>
    ).flatMap((r) => {
      try {
        return [(JSON.parse(r.v) as StudentVoice).voice];
      } catch {
        return [];
      }
    });
    const picked = pickVoice(speech.cfg.tts, { ...row, register }, taken);
    sqlite
      .prepare("UPDATE cadets SET voice_json = ? WHERE id = ?")
      .run(JSON.stringify(picked), row.id);
    return picked;
  }
}
