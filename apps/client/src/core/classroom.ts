import type {
  CadetView,
  ConceptView,
  HandView,
  ReactionState,
  ServerMessage,
  ServerMessageOf,
  XpStanding,
} from "@lumen/shared";

// Client-side classroom state, derived from server messages by a pure reducer
// (applyServerMessage) so it's testable without a browser.

export interface CadetState extends CadetView {
  /** Reaction from the current turn; resets to attentive is the server's call. */
  state: ReactionState;
}

export interface Speech {
  cadetId: string;
  streamId: string;
  text: string;
  done: boolean;
  messageId?: string;
  /** Set while the Leak Guard's replacement is fading in. */
  rephrasedAt?: number;
}

export interface TranscriptEntry {
  speaker: "headmaster" | "cadet";
  cadetId?: string;
  messageId?: string;
  text: string;
}

export interface Toast {
  id: number;
  level: "info" | "warn" | "error";
  text: string;
}

export interface ClassroomState {
  status: "idle" | "starting" | "live" | "ending" | "ended";
  periodId?: string;
  school?: { id: string; name: string };
  classroom?: { id: string; name: string };
  concept?: ConceptView;
  concepts: ConceptView[];
  cadets: Record<string, CadetState>;
  hands: HandView[];
  transcript: TranscriptEntry[];
  speech: Speech | null;
  plannedMinutes: number;
  /** The server's teaching clock: elapsedMs as of `at` (client time), frozen while paused. */
  clock: { elapsedMs: number; at: number; paused: boolean };
  /** This period was picked up after a reload; the pause card says "Welcome back". */
  resumed: boolean;
  recap?: string;
  classAverage: number | null;
  cost: {
    periodUsd: number;
    dayUsd: number;
    monthUsd: number;
    capUsd: number;
    state: "ok" | "warn" | "degrade" | "pause";
  };
  /** For the latency HUD: when the last message was sent and first reacted to. */
  lastSendAt?: number;
  lastReactionMs?: number;
  thinking: boolean;
  toasts: Toast[];
  /** Headmaster rank and XP (all time). */
  xp: XpStanding | null;
  /** The last XP gain, for the "+15 XP" flourish. */
  xpGain?: { delta: number; reason: string; at: number };
  ended?: Omit<ServerMessageOf<"period.ended">["payload"], "periodId">;
}

export const initialClassroom = (): ClassroomState => ({
  status: "idle",
  concepts: [],
  cadets: {},
  hands: [],
  transcript: [],
  speech: null,
  plannedMinutes: 15,
  clock: { elapsedMs: 0, at: 0, paused: false },
  resumed: false,
  classAverage: null,
  cost: { periodUsd: 0, dayUsd: 0, monthUsd: 0, capUsd: 20, state: "ok" },
  thinking: false,
  toasts: [],
  xp: null,
});

let toastSeq = 0;
const MAX_TOASTS = 3;

export function applyServerMessage(
  s: ClassroomState,
  m: ServerMessage,
  now = Date.now(),
): ClassroomState {
  switch (m.type) {
    case "period.started":
      return {
        ...initialClassroom(),
        cost: s.cost,
        status: "live",
        periodId: m.payload.periodId,
        school: m.payload.school,
        classroom: m.payload.classroom,
        concept: m.payload.concept,
        concepts: m.payload.concepts,
        cadets: Object.fromEntries(m.payload.cadets.map((c) => [c.id, { ...c }])),
        plannedMinutes: m.payload.plannedMinutes,
        clock: { elapsedMs: m.payload.elapsedMs, at: now, paused: m.payload.paused },
        resumed: m.payload.resumed,
        xp: m.payload.xp,
        transcript: m.payload.transcript.map((t) => ({
          speaker: t.cadetId ? "cadet" : "headmaster",
          cadetId: t.cadetId,
          messageId: t.messageId,
          text: t.text,
        })),
      };
    case "xp.update":
      return {
        ...s,
        xp: m.payload.standing,
        xpGain: { delta: m.payload.delta, reason: m.payload.reason, at: now },
      };
    case "period.paused":
      return {
        ...s,
        clock: { elapsedMs: m.payload.elapsedMs, at: now, paused: m.payload.paused },
        speech: m.payload.paused && s.speech && !s.speech.done ? null : s.speech,
        thinking: false,
      };
    case "period.recap":
      return m.payload.periodId === s.periodId ? { ...s, recap: m.payload.text } : s;
    case "turn.started":
      return {
        ...s,
        thinking: true,
        speech: s.speech?.done ? null : s.speech,
        transcript: [...s.transcript, { speaker: "headmaster", text: m.payload.text }],
      };
    case "crowd.reaction": {
      const c = s.cadets[m.payload.cadetId];
      if (!c) return s;
      const first =
        s.lastSendAt !== undefined && s.thinking ? now - s.lastSendAt : s.lastReactionMs;
      return {
        ...s,
        thinking: false,
        lastReactionMs: s.thinking ? first : s.lastReactionMs,
        cadets: { ...s.cadets, [c.id]: { ...c, state: m.payload.state } },
      };
    }
    case "crowd.done":
      return { ...s, thinking: false };
    case "hands.update":
      return { ...s, hands: m.payload.queue };
    case "ledger.update": {
      if (m.payload.conceptId !== s.concept?.id) return s;
      const cadets = { ...s.cadets };
      for (const u of m.payload.cadets)
        if (cadets[u.cadetId])
          cadets[u.cadetId] = { ...cadets[u.cadetId]!, comprehension: u.comprehension };
      return { ...s, cadets, classAverage: m.payload.classAverage };
    }
    case "concept.changed":
      return { ...s, concept: m.payload, classAverage: null };
    case "cadet.stream": {
      const same = s.speech && s.speech.streamId === m.payload.streamId;
      const speech: Speech = same
        ? { ...s.speech!, text: s.speech!.text + m.payload.delta }
        : {
            cadetId: m.payload.cadetId,
            streamId: m.payload.streamId,
            text: m.payload.delta,
            done: false,
          };
      return { ...s, speech };
    }
    case "cadet.done":
      return {
        ...s,
        speech: {
          cadetId: m.payload.cadetId,
          streamId: m.payload.streamId,
          text: m.payload.text,
          done: true,
          messageId: m.payload.messageId,
        },
        transcript: [
          ...s.transcript,
          {
            speaker: "cadet",
            cadetId: m.payload.cadetId,
            messageId: m.payload.messageId,
            text: m.payload.text,
          },
        ],
      };
    case "cadet.interrupted":
      return s.speech?.streamId === m.payload.streamId ? { ...s, speech: null } : s;
    case "cadet.rewrite":
      return {
        ...s,
        speech:
          s.speech?.messageId === m.payload.messageId
            ? { ...s.speech, text: m.payload.text, rephrasedAt: now }
            : s.speech,
        transcript: s.transcript.map((t) =>
          t.messageId === m.payload.messageId ? { ...t, text: m.payload.text } : t,
        ),
      };
    case "cost.update":
      return { ...s, cost: m.payload };
    case "toast":
    case "error": {
      const toast: Toast =
        m.type === "toast"
          ? { id: ++toastSeq, ...m.payload }
          : { id: ++toastSeq, level: "error", text: m.payload.message };
      return {
        ...s,
        thinking: false,
        toasts: [...s.toasts, toast].slice(-MAX_TOASTS),
        status: s.status === "starting" ? "idle" : s.status,
      };
    }
    case "period.ended":
      return {
        ...s,
        status: "ended",
        ended: {
          turns: m.payload.turns,
          minutes: m.payload.minutes,
          costUsd: m.payload.costUsd,
          recapOut: m.payload.recapOut,
          xp: m.payload.xp,
        },
        xp: m.payload.xp.standing,
        speech: null,
        hands: [],
      };
    case "pong":
      return s;
  }
}

/** Teaching time on the clock now, in ms. */
export const elapsedMs = (s: ClassroomState, now = Date.now()) =>
  s.clock.elapsedMs + (s.clock.paused || s.status !== "live" ? 0 : now - s.clock.at);

export const dismissToast = (s: ClassroomState, id: number): ClassroomState => ({
  ...s,
  toasts: s.toasts.filter((t) => t.id !== id),
});
