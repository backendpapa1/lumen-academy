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

// --- Client → Server ----------------------------------------------------------------

export const ClientMessageZ = z.discriminatedUnion("type", [
  msg("ping", z.strictObject({ nonce: z.string().max(64) })),
  msg(
    "period.start",
    z.strictObject({
      classroomId: z.string(),
      conceptId: z.string().optional(),
      minutes: z.number().int().min(5).max(45).optional(),
    }),
  ),
  msg(
    "teach.message",
    z.strictObject({
      text: z.string().trim().min(1).max(4000),
      replyToCadetId: z.string().optional(),
    }),
  ),
  msg("hand.call", z.strictObject({ cadetId: z.string() })),
  msg("concept.set", z.strictObject({ conceptId: z.string() })),
  /** T-9: the chalkboard block; empty text clears it. */
  msg("board.set", z.strictObject({ text: z.string().max(600) })),
  msg("period.pause", empty),
  /** T-7: more time after the bell. */
  msg("period.extend", z.strictObject({ minutes: z.number().int().min(1).max(30) })),
  msg("period.resume", empty),
  msg("period.end", empty),
  /** Exit ticket (M4-05): ✓ = true, ✗ = false. */
  msg("exit.mark", z.strictObject({ ticketId: z.string(), verdict: z.boolean() })),
  msg("exit.done", z.strictObject({ periodId: z.string() })),
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
