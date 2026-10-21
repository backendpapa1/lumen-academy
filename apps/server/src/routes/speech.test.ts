import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { voiceRegister } from "@lumen/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { glossaryFor } from "../speech/glossary.js";
import { cleanTranscript, type Transcriber } from "../speech/stt.js";
import type { Speaker } from "../speech/tts.js";
import { pickVoice } from "../speech/voices.js";
import { fakeDeepSeekFactory } from "../test-fixtures/fakeDeepSeek.js";
import { smallWorld } from "../test-fixtures/world.js";
import { UsageMeter } from "../usage/meter.js";

const cfg = loadConfig({ env: {} });
const speechCfg = cfg.models.speech!;
let app: FastifyInstance | undefined;
let h: DbHandle | undefined;
afterEach(async () => {
  await app?.close();
  h?.close();
});

function fakeStt(): Transcriber & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    problem: null,
    status: () => "ready",
    transcribe: async (_a, _m, prompt) => {
      prompts.push(prompt);
      return { text: "The root lives in the header.", ms: 12 };
    },
    close: () => {},
  };
}
const fakeTts = (): Speaker & { said: Array<[string, string, number]> } => {
  const said: Array<[string, string, number]> = [];
  return {
    said,
    problem: null,
    status: () => "ready",
    say: async (text, voice, speed) => {
      said.push([text, voice, speed]);
      return { wav: Buffer.from("RIFF0000WAVE"), ms: 5 };
    },
  };
};

async function boot(
  reply: (body: { messages: Array<{ role: string; content: string }> }) => string = () => "{}",
) {
  const w = await smallWorld([
    { attention: 0.5, skepticism: 0.5 },
    { attention: 0.6, skepticism: 0.2 },
  ]);
  h = w.handle;
  const meter = new UsageMeter({ db: h.db, pricing: cfg.pricing, budget: cfg.models.budget });
  const { factory } = fakeDeepSeekFactory(cfg.models, reply, { meter });
  const stt = fakeStt();
  const tts = fakeTts();
  app = await buildApp({
    config: cfg,
    runtime: { handle: h, factory, meter, game: cfg.game, speech: { cfg: speechCfg, stt, tts } },
  });
  return { w, app, stt, tts };
}

describe("voices", () => {
  it("keeps a student's register and spreads classmates over the pool", () => {
    const ids = Array.from({ length: 15 }, (_, i) => `cdt_${i}`);
    const taken: string[] = [];
    for (const id of ids) {
      const v = pickVoice(speechCfg.tts, { id, archetype: "skeptic" }, taken);
      expect(speechCfg.tts.voices[voiceRegister(id)]).toContain(v.voice);
      taken.push(v.voice);
    }
    // 11 female + 8 male voices: a class of 15 gets at least 12 different ones.
    expect(new Set(taken).size).toBeGreaterThanOrEqual(12);
    expect(pickVoice(speechCfg.tts, { id: "cdt_x", archetype: "quiet" }).speed).toBe(0.9);
  });

  it("is the same student, the same voice", () => {
    const a = pickVoice(speechCfg.tts, { id: "cdt_7", archetype: "connector" });
    expect(pickVoice(speechCfg.tts, { id: "cdt_7", archetype: "connector" })).toEqual(a);
  });
});

describe("transcripts", () => {
  it("drops Whisper's noise markers", () => {
    expect(cleanTranscript(" [BLANK_AUDIO] ")).toBe("");
    expect(cleanTranscript("So (coughs) the root [Music] lives here.")).toBe(
      "So the root lives here.",
    );
  });
});

describe("speech routes", () => {
  it("transcribes with the School's glossary as the prompt", async () => {
    const { w, app, stt } = await boot();
    expect(glossaryFor(w.handle, w.schoolId, 600)).toMatch(/^Glossary:/);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(4000)], { type: "audio/webm" }), "a.webm");
    const res = await app.inject({
      method: "POST",
      url: `/api/speech/transcribe?classroomId=${w.classroomId}`,
      payload: form,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ text: "The root lives in the header." });
    expect(stt.prompts[0]).toMatch(/^Glossary:/);
  });

  it("fixes clear mishearings with the School's terms, and keeps what was heard", async () => {
    let seen = "";
    const { w, app } = await boot((body) => {
      seen = body.messages.map((m) => m.content).join("\n");
      return JSON.stringify({ text: "The Merkle root lives in the header." });
    });
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(4000)], { type: "audio/webm" }), "a.webm");
    const res = await app.inject({
      method: "POST",
      url: `/api/speech/transcribe?classroomId=${w.classroomId}`,
      payload: form,
    });
    expect(res.json()).toMatchObject({
      text: "The Merkle root lives in the header.",
      heard: "The root lives in the header.",
    });
    expect(seen).toContain("speech-recognition mistakes");
    expect(seen).toContain("Glossary:");
  });

  it("learns my fixes per School and feeds them back to Whisper and the fixer", async () => {
    let fixerPrompt = "";
    const { w, app, stt } = await boot((body) => {
      fixerPrompt = body.messages.map((m) => m.content).join("\n");
      return JSON.stringify({ text: "Nodes follow the chain with the most work." });
    });
    const learn = await app.inject({
      method: "POST",
      url: "/api/speech/corrections",
      payload: {
        classroomId: w.classroomId,
        suggested: "Not follow the chain with the most work.",
        sent: "Nodes follow the chain with the most work.",
      },
    });
    expect(learn.json()).toEqual({ learned: [{ heard: "not", meant: "Nodes" }] });
    // A rewrite isn't a fix: nothing learned.
    const rewrite = await app.inject({
      method: "POST",
      url: "/api/speech/corrections",
      payload: {
        classroomId: w.classroomId,
        suggested: "Pairs are hashed.",
        sent: "Let me start again on roots and headers.",
      },
    });
    expect(rewrite.json()).toEqual({ learned: [] });

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(4000)], { type: "audio/webm" }), "a.webm");
    await app.inject({
      method: "POST",
      url: `/api/speech/transcribe?classroomId=${w.classroomId}`,
      payload: form,
    });
    expect(stt.prompts.at(-1)).toMatch(/^Glossary: Nodes/);
    expect(fixerPrompt).toContain('"not" → "Nodes" (1×)');
  });

  it("ignores a click that's too short to be speech", async () => {
    const { w, app, stt } = await boot();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(100)], { type: "audio/webm" }), "a.webm");
    const res = await app.inject({
      method: "POST",
      url: `/api/speech/transcribe?classroomId=${w.classroomId}`,
      payload: form,
    });
    expect(res.json()).toEqual({ text: "", ms: 0 });
    expect(stt.prompts).toHaveLength(0);
  });

  it("speaks a line in the student's own voice, picked once and kept", async () => {
    const { w, app, tts } = await boot();
    const id = w.cadets[0]!.id;
    const say = () =>
      app.inject({
        method: "POST",
        url: "/api/speech/say",
        payload: { cadetId: id, text: "Wait," },
      });
    const a = await say();
    expect(a.statusCode).toBe(200);
    expect(a.headers["content-type"]).toMatch(/audio\/wav/);
    await say();
    expect(tts.said[0]![1]).toBe(tts.said[1]![1]);
    const row = w.handle.sqlite.prepare("SELECT voice_json FROM cadets WHERE id = ?").get(id) as {
      voice_json: string;
    };
    expect(JSON.parse(row.voice_json).voice).toBe(tts.said[0]![1]);
    const status = await app.inject({ method: "GET", url: "/api/speech/status" });
    expect(status.json()).toMatchObject({ stt: "ready", tts: "ready" });
  });
});
