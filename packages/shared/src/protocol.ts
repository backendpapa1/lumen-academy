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
  text: z.string(),
});
export type TranscriptLineView = z.infer<typeof TranscriptLineViewZ>;

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
  msg("period.end", empty),
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
      transcript: z.array(TranscriptLineViewZ),
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
    }),
  ),
]);
export type ServerMessage = z.infer<typeof ServerMessageZ>;
export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

export const WS_PATH = "/ws";
