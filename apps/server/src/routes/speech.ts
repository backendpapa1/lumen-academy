import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import type { SpeechConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { glossaryFor } from "../speech/glossary.js";
import type { Speaker } from "../speech/tts.js";
import type { Transcriber } from "../speech/stt.js";
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
  deps: { handle: DbHandle; meter: UsageMeter; speech: SpeechRuntime },
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

  app.post<{ Querystring: { classroomId?: string } }>(
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
        return { text: r.text, ms: Math.round(r.ms) };
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

  function voiceOf(cadetId: string): StudentVoice | null {
    const row = sqlite
      .prepare(
        "SELECT id, archetype, classroom_id AS room, voice_json AS v FROM cadets WHERE id = ?",
      )
      .get(cadetId) as
      { id: string; archetype: string; room: string; v: string | null } | undefined;
    if (!row) return null;
    if (row.v) {
      try {
        return JSON.parse(row.v) as StudentVoice;
      } catch {
        /* re-pick below */
      }
    }
    const taken = (
      sqlite
        .prepare(
          "SELECT voice_json AS v FROM cadets WHERE classroom_id = ? AND voice_json IS NOT NULL",
        )
        .all(row.room) as Array<{ v: string }>
    ).flatMap((r) => {
      try {
        return [(JSON.parse(r.v) as StudentVoice).voice];
      } catch {
        return [];
      }
    });
    const picked = pickVoice(speech.cfg.tts, row, taken);
    sqlite
      .prepare("UPDATE cadets SET voice_json = ? WHERE id = ?")
      .run(JSON.stringify(picked), row.id);
    return picked;
  }
}
