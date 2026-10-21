import { DiagramZ } from "./diagram.js";
import { PERIOD_KINDS } from "./modes.js";
import { z } from "zod";
import { ArchetypeZ, HandIntentZ, MOODS, ReactionStateZ, UTTERANCE_KINDS } from "./agents.js";

// WebSocket protocol (docs/05 §5). Every message is { type, sessionId?, payload },
// Zod-validated on both ends. One active Class Period per connection.
//
// Privacy rule (docs/03 §4.2): the Director's analysis, and especially the
// teacher's errors, never reach the client during class; they surface in the
// Debrief. Only reactions, hands, speech, comprehension and cost do.

export const EnvelopeZ = z.strictObject({
  type: z.string().min(1),
  sessionId: z.string().optional(),
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof EnvelopeZ>;

const msg = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({ type: z.literal(type), sessionId: z.string().optional(), payload });

const empty = z.strictObject({});

// --- Shared view models -----------------------------------------------------------

export const CadetViewZ = z.object({
  id: z.string(),
  name: z.string(),
  archetype: ArchetypeZ,
  seat: z.number().int().min(0).max(14),
  homeworld: z.string(),
  quirk: z.string(),
  /** On the current concept, 0..1. */
  comprehension: z.number(),
  state: ReactionStateZ,
  /** Portrait image URL (server-relative), once generated. */
  portraitUrl: z.string().nullable().optional(),
  /** V4-07: the Registrar's hair description, so the drawn student matches it. */
  hair: z.string().optional(),
  /** V4-04 */
  interests: z.array(z.string()).optional(),
  /** V4-03: where they are in their growth arc, and what moves them on. */
  arc: z.object({ stage: z.number().int(), label: z.string(), trigger: z.string() }).optional(),
});
export type CadetView = z.infer<typeof CadetViewZ>;

export const ConceptViewZ = z.object({ id: z.string(), title: z.string() });
export type ConceptView = z.infer<typeof ConceptViewZ>;

export const HandViewZ = z.object({
  cadetId: z.string(),
  intent: HandIntentZ,
  preview: z.string(),
  urgency: z.number(),
});
export type HandView = z.infer<typeof HandViewZ>;

export const TranscriptLineViewZ = z.object({
  speaker: z.string(),
  cadetId: z.string().optional(),
  messageId: z.string().optional(),
  text: z.string(),
});
export type TranscriptLineView = z.infer<typeof TranscriptLineViewZ>;

export const XpStandingZ = z.object({
  total: z.number(),
  rank: z.string(),
  next: z.object({ name: z.string(), minXp: z.number() }).nullable(),
  progress: z.number(),
});
export type XpStanding = z.infer<typeof XpStandingZ>;

export const BudgetStateZ = z.enum(["ok", "warn", "degrade", "pause"]);
export const PeriodKindZ = z.enum(PERIOD_KINDS);
export const GlossaryTermZ = z.strictObject({
  term: z.string(),
  definition: z.string(),
  agrees: z.boolean(),
  note: z.string().nullable(),
});
export const StickerViewZ = z.strictObject({
  id: z.string(),
  cadetId: z.string(),
  kind: z.string(),
  label: z.string(),
});
export type StickerView = z.infer<typeof StickerViewZ>;
export const EnergyZ = z.enum(["low", "ok", "high"]);

// --- Client → Server ----------------------------------------------------------------

export const ClientMessageZ = z.discriminatedUnion("type", [
  msg("ping", z.strictObject({ nonce: z.string().max(64) })),
  msg(
    "period.start",
    z.strictObject({
      classroomId: z.string(),
      conceptId: z.string().optional(),
      minutes: z.number().int().min(5).max(45).optional(),
      /** V3-01: a micro-lesson, one student (picked by the server if omitted). */
      kind: PeriodKindZ.optional(),
      cadetId: z.string().optional(),
      /** V3-02: the optional energy check-in. */
      energy: EnergyZ.optional(),
    }),
  ),
  msg(
    "teach.message",
    z.strictObject({
      text: z.string().trim().min(1).max(4000),
      replyToCadetId: z.string().optional(),
      /** V7-06: said aloud (voice) rather than typed. */
      spoken: z.boolean().optional(),
    }),
  ),
  msg("hand.call", z.strictObject({ cadetId: z.string() })),
  msg("concept.set", z.strictObject({ conceptId: z.string() })),
  /** T-9: the chalkboard block; empty text clears it. */
  msg("board.set", z.strictObject({ text: z.string().max(600) })),
  /** T-10 Hyperfocus mode (docs/05 §5: focus.toggle). */
  msg("focus.toggle", z.strictObject({ on: z.boolean() })),
  /** Random events (docs/02 §6): my answer to a pop quiz, or my verdict on a glitch. */
  msg(
    "event.answer",
    z.strictObject({
      eventId: z.string(),
      text: z.string().max(2000).optional(),
      wrong: z.boolean().optional(),
    }),
  ),
  msg("period.pause", empty),
  /** T-7: more time after the bell. */
  msg("period.extend", z.strictObject({ minutes: z.number().int().min(1).max(30) })),
  msg("period.resume", empty),
  msg("period.end", empty),
  /** Exit ticket (M4-05): ✓ = true, ✗ = false. */
  msg("exit.mark", z.strictObject({ ticketId: z.string(), verdict: z.boolean() })),
  msg("exit.done", z.strictObject({ periodId: z.string() })),
  /** V5-04: my verdict on one analogy, and where I think it breaks down. */
  msg(
    "analogy.judge",
    z.strictObject({
      i: z.number().int().min(0).max(5),
      verdict: z.enum(["good", "misleading"]),
      reason: z.string().max(600),
    }),
  ),
  /** V6-09: the diagram I drew on the board (objects, not pixels). */
  msg("board.diagram", z.strictObject({ diagram: DiagramZ })),
  /** V6-06: show me the passage of my sources that matches what I just said. */
  msg("source.check", z.strictObject({ text: z.string().max(1000).optional() })),
  /** V5-09: invite the guest lecturer (on a question, or the class's latest one). */
  msg("guest.invite", z.strictObject({ question: z.string().max(500).optional() })),
  /** V5-08: I object to the substitute's line i; finish ends the lesson. */
  msg("sub.object", z.strictObject({ i: z.number().int().min(0).max(20) })),
  msg("sub.finish", empty),
  /** V5-03: the sentences of a teach-back I think are wrong (indexes). */
  msg("teachback.mark", z.strictObject({ wrong: z.array(z.number().int().min(0).max(20)) })),
]);
export type ClientMessage = z.infer<typeof ClientMessageZ>;

// --- Server → Client ----------------------------------------------------------------

export const ServerMessageZ = z.discriminatedUnion("type", [
  msg("pong", z.strictObject({ nonce: z.string(), serverTime: z.string() })),
  msg("error", z.strictObject({ code: z.string(), message: z.string() })),
  msg("toast", z.strictObject({ level: z.enum(["info", "warn", "error"]), text: z.string() })),
  msg(
    "period.started",
    z.strictObject({
      periodId: z.string(),
      school: z.object({ id: z.string(), name: z.string() }),
      classroom: z.object({ id: z.string(), name: z.string() }),
      concept: ConceptViewZ,
      concepts: z.array(ConceptViewZ),
      cadets: z.array(CadetViewZ),
      plannedMinutes: z.number(),
      /** Teaching time already spent (non-zero when resumed). */
      elapsedMs: z.number(),
      /** Picked up an unfinished period; it starts paused. */
      resumed: z.boolean(),
      paused: z.boolean(),
      /** The chalkboard block, if one was written this period (T-9). */
      board: z.string().optional(),
      transcript: z.array(TranscriptLineViewZ),
      xp: XpStandingZ,
      /** V2-04: days since this concept was last taught in this class (null: never). */
      lastTaughtDays: z.number().int().nullable().optional(),
      kind: PeriodKindZ.optional(),
      energy: EnergyZ.nullable().optional(),
      /** V4-06: the corkboard, latest first. */
      stickers: z.array(StickerViewZ).optional(),
      /** V5: the student at the centre of a Socratic or teach-back period. */
      hotSeat: z.string().nullable().optional(),
      /** V6-08: the glossary wall, latest first. */
      glossary: z.array(GlossaryTermZ).optional(),
      /** V6-09: the diagram on the board this period, if I drew one. */
      diagram: DiagramZ.optional(),
      /** V7-01: room upgrades in this classroom, and which are new since the last class. */
      upgrades: z.array(z.string()).optional(),
      newUpgrades: z.array(z.string()).optional(),
      /** V7-01: the School's accent and emblem for the subject poster. */
      emblemUrl: z.string().nullable().optional(),
    }),
  ),
  /** XP just earned (e.g. answering a cadet's question). */
  msg(
    "xp.update",
    z.strictObject({ delta: z.number(), reason: z.string(), standing: XpStandingZ }),
  ),
  /** A generated image is ready (or failed). url is server-relative: /api/assets/<id>. */
  msg(
    "asset.ready",
    z.strictObject({
      assetId: z.string(),
      kind: z.string(),
      ownerType: z.string().nullable(),
      ownerId: z.string().nullable(),
      status: z.enum(["ready", "error"]),
      url: z.string().nullable(),
    }),
  ),
  /** Background jobs started over REST report here (docs/05 §7.6). */
  msg(
    "source.status",
    z.strictObject({
      schoolId: z.string(),
      sourceId: z.string().nullable(),
      title: z.string(),
      status: z.enum(["queued", "parsing", "embedding", "ready", "error"]),
      detail: z.string().optional(),
    }),
  ),
  msg(
    "curriculum.status",
    z.strictObject({
      schoolId: z.string(),
      status: z.enum(["building", "ready", "error"]),
      detail: z.string().optional(),
    }),
  ),
  /** Registration (docs/02 §4): the class exists, then cadets arrive one by one. */
  msg(
    "registration.started",
    z.strictObject({
      classroomId: z.string(),
      schoolId: z.string(),
      name: z.string(),
      total: z.number(),
    }),
  ),
  msg(
    "registration.arrival",
    z.strictObject({
      classroomId: z.string(),
      cadet: CadetViewZ,
      index: z.number(),
      total: z.number(),
    }),
  ),
  msg(
    "registration.done",
    z.strictObject({
      classroomId: z.string(),
      status: z.enum(["active", "error"]),
      detail: z.string().optional(),
    }),
  ),
  /** Homework being collected and reference-graded (A-2, A-4). */
  msg(
    "assignment.status",
    z.strictObject({
      assignmentId: z.string(),
      classroomId: z.string(),
      status: z.enum(["collecting", "submitted", "error"]),
      done: z.number(),
      total: z.number(),
      detail: z.string().optional(),
    }),
  ),
  /** Exam arena (E-3): questions are generated, then each graded answer streams in. */
  msg(
    "exam.status",
    z.strictObject({
      examId: z.string(),
      classroomId: z.string(),
      status: z.enum(["generating", "ready", "running", "done", "error"]),
      detail: z.string().optional(),
    }),
  ),
  msg(
    "exam.answer",
    z.strictObject({
      examId: z.string(),
      questionId: z.string(),
      ord: z.number(),
      cadetId: z.string(),
      score: z.number(),
      /** Running class mean so far, 0..1 (the "Class Integrity" bar). */
      integrity: z.number(),
    }),
  ),
  msg(
    "exit.tickets",
    z.strictObject({
      periodId: z.string(),
      conceptTitle: z.string(),
      seconds: z.number(),
      tickets: z.array(z.object({ id: z.string(), cadetId: z.string(), statement: z.string() })),
    }),
  ),
  msg(
    "exit.result",
    z.strictObject({
      ticketId: z.string(),
      right: z.boolean(),
      isTrue: z.boolean(),
      corrected: z.boolean(),
    }),
  ),
  msg(
    "exit.summary",
    z.strictObject({
      periodId: z.string(),
      marked: z.number(),
      total: z.number(),
      right: z.number(),
      xp: z.number(),
    }),
  ),
  msg("period.paused", z.strictObject({ paused: z.boolean(), elapsedMs: z.number() })),
  msg("period.extended", z.strictObject({ plannedMinutes: z.number() })),
  msg("board.updated", z.strictObject({ text: z.string() })),
  msg("focus.changed", z.strictObject({ on: z.boolean() })),
  msg(
    "event.start",
    z.strictObject({
      eventId: z.string(),
      kind: z.enum([
        "pop_quiz",
        "glitch",
        "power_flicker",
        "inspector",
        "recheck",
        "debate",
        "transfer",
      ]),
      /** The cadet it's about; absent for the visiting Dean. */
      cadetId: z.string().optional(),
      /** Pop quiz question; the glitch line; the misconception whispered in a flicker. */
      text: z.string(),
      /** Flicker: who it spread to. */
      toCadetId: z.string().optional(),
      seconds: z.number(),
    }),
  ),
  msg(
    "event.result",
    z.strictObject({
      eventId: z.string(),
      kind: z.enum([
        "pop_quiz",
        "glitch",
        "power_flicker",
        "inspector",
        "recheck",
        "debate",
        "transfer",
      ]),
      /** Pop quiz: Grader score 0–5. */
      score: z.number().optional(),
      /** Glitch: did I catch it? and what it got wrong. */
      caught: z.boolean().optional(),
      explanation: z.string(),
      xp: z.number(),
      /** Inspector: the Dean's feedback on my last few explanations. */
      feedback: z
        .strictObject({
          strengths: z.array(z.string()),
          improve: z.array(z.string()),
          tip: z.string(),
        })
        .optional(),
    }),
  ),
  /** "Last time…" arrives after period.started so starting a class never waits on it. */
  msg("period.recap", z.strictObject({ periodId: z.string(), text: z.string() })),
  msg("turn.started", z.strictObject({ turnId: z.string(), text: z.string() })),
  msg(
    "crowd.reaction",
    z.strictObject({ turnId: z.string(), cadetId: z.string(), state: ReactionStateZ }),
  ),
  msg("crowd.done", z.strictObject({ turnId: z.string(), firstReactionMs: z.number().nullable() })),
  msg("hands.update", z.strictObject({ queue: z.array(HandViewZ) })),
  msg(
    "ledger.update",
    z.strictObject({
      turnId: z.string(),
      conceptId: z.string(),
      cadets: z.array(z.object({ cadetId: z.string(), comprehension: z.number() })),
      classAverage: z.number(),
    }),
  ),
  msg("concept.changed", ConceptViewZ),
  msg(
    "cadet.stream",
    z.strictObject({ cadetId: z.string(), streamId: z.string(), delta: z.string() }),
  ),
  msg(
    "cadet.done",
    z.strictObject({
      cadetId: z.string(),
      streamId: z.string(),
      messageId: z.string(),
      text: z.string(),
      kind: z.enum(UTTERANCE_KINDS),
      mood: z.enum(MOODS),
    }),
  ),
  msg("cadet.interrupted", z.strictObject({ cadetId: z.string(), streamId: z.string() })),
  /** V4-01: one student turns to another; their lines follow as cadet.stream/done. */
  msg("peer.started", z.strictObject({ speakerId: z.string(), listenerId: z.string() })),
  msg("peer.ended", z.strictObject({ speakerId: z.string(), listenerId: z.string() })),
  /** V5-04: the Connector's analogies to judge. */
  msg("analogy.cards", z.strictObject({ cadetId: z.string(), cards: z.array(z.string()) })),
  msg(
    "analogy.result",
    z.strictObject({
      i: z.number().int(),
      sound: z.boolean(),
      right: z.boolean(),
      reasonScore: z.number(),
      feedback: z.string(),
      breaks: z.string(),
    }),
  ),
  /** V6-08: a term I defined was pinned (or re-pinned) on the glossary wall. */
  msg("glossary.update", z.strictObject({ terms: z.array(GlossaryTermZ) })),
  /** V6-06: the matching passage from my sources (mine only). */
  msg(
    "source.passage",
    z.strictObject({
      query: z.string(),
      text: z.string(),
      source: z.string(),
      heading: z.string(),
      page: z.number().nullable(),
      url: z.string().nullable(),
    }),
  ),
  /** V5-09: the guest lecturer's answer, from my sources only, with references. */
  msg(
    "guest.answer",
    z.strictObject({
      name: z.string(),
      question: z.string(),
      answer: z.string(),
      citations: z.array(
        z.strictObject({ source: z.string(), heading: z.string(), page: z.number().nullable() }),
      ),
      left: z.number().int(),
    }),
  ),
  /** V5-05: an ELI round starts, and how my explanation fit its audience. */
  msg(
    "eli.round",
    z.strictObject({
      round: z.number().int(),
      of: z.number().int(),
      level: z.enum(["eli5", "eli15", "expert"]),
      audience: z.string(),
    }),
  ),
  msg(
    "eli.scored",
    z.strictObject({ round: z.number().int(), score: z.number(), feedback: z.string() }),
  ),
  /** V5-08: the substitute's lesson (lines revealed one by one on the client). */
  msg("sub.lesson", z.strictObject({ lines: z.array(z.string()) })),
  msg(
    "sub.objection",
    z.strictObject({ i: z.number().int(), planted: z.boolean(), correction: z.string() }),
  ),
  msg(
    "sub.result",
    z.strictObject({
      lines: z.array(
        z.strictObject({
          text: z.string(),
          planted: z.boolean(),
          objected: z.boolean(),
          correction: z.string(),
        }),
      ),
      caught: z.number(),
      missed: z.number(),
      falseAlarms: z.number(),
      score: z.number(),
    }),
  ),
  /** V5-03: a student explained it back; mark the wrong sentences. */
  msg("teachback.ready", z.strictObject({ cadetId: z.string(), sentences: z.array(z.string()) })),
  msg(
    "teachback.result",
    z.strictObject({
      lines: z.array(z.strictObject({ text: z.string(), true: z.boolean(), marked: z.boolean() })),
      caught: z.number(),
      missed: z.number(),
      falseAlarms: z.number(),
      score: z.number(),
    }),
  ),
  /** V5-11: a transfer student joined mid-module. */
  msg("cadet.joined", z.strictObject({ cadet: CadetViewZ })),
  /** V4-03: a student moved on in their growth arc. */
  msg(
    "cadet.arc",
    z.strictObject({
      cadetId: z.string(),
      stage: z.number().int(),
      label: z.string(),
      moment: z.string(),
    }),
  ),
  /** V4-06: a student gave me a sticker. */
  msg("sticker", StickerViewZ),
  msg(
    "cadet.rewrite",
    z.strictObject({ messageId: z.string(), cadetId: z.string(), text: z.string() }),
  ),
  msg(
    "cost.update",
    z.strictObject({
      periodUsd: z.number(),
      dayUsd: z.number(),
      monthUsd: z.number(),
      capUsd: z.number(),
      state: BudgetStateZ,
    }),
  ),
  msg(
    "period.ended",
    z.strictObject({
      periodId: z.string(),
      turns: z.number(),
      minutes: z.number(),
      costUsd: z.number(),
      recapOut: z.string().optional(),
      /** V5: what the mode found (Socratic questions, teach-back catches…). */
      mode: z
        .strictObject({
          kind: PeriodKindZ,
          title: z.string(),
          lines: z.array(z.string()),
          score: z.number().optional(),
        })
        .optional(),
      xp: z.strictObject({
        earned: z.number(),
        breakdown: z.array(z.object({ kind: z.string(), amount: z.number() })),
        standing: XpStandingZ,
        rankedUp: z.boolean(),
      }),
    }),
  ),
]);
export type ServerMessage = z.infer<typeof ServerMessageZ>;
export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

export const WS_PATH = "/ws";
