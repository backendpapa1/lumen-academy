import type {
  CadetView,
  ConceptView,
  HandView,
  ReactionState,
  ServerMessage,
  ServerMessageOf,
  PeriodKind,
  StickerView,
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

export interface ExitTicketsState {
  periodId: string;
  conceptTitle: string;
  seconds: number;
  /** Client time the minute started. */
  at: number;
  tickets: Array<{
    id: string;
    cadetId: string;
    statement: string;
    verdict?: boolean;
    right?: boolean;
    isTrue?: boolean;
  }>;
  summary?: { marked: number; total: number; right: number; xp: number };
}

/** A random event (M6-01): pop quiz, hologram glitch or power flicker. */
export interface EventState {
  id: string;
  kind: "pop_quiz" | "glitch" | "power_flicker" | "inspector" | "recheck" | "debate" | "transfer";
  /** Absent for the visiting Dean. */
  cadetId?: string;
  toCadetId?: string;
  text: string;
  seconds: number;
  /** Client time it started. */
  at: number;
  sent?: boolean;
  /** Inspector: explanations the Dean has watched so far. */
  watched?: number;
  result?: Omit<ServerMessageOf<"event.result">["payload"], "eventId" | "kind">;
}

export interface ParkedItem {
  id: string;
  text: string;
  status: "open" | "kept" | "concept" | "dismissed";
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
  /** T-9: the chalkboard block on the holo-board. */
  board: string;
  /** V2-04: days since this concept was last taught in this class (null: new). */
  lastTaughtDays: number | null;
  /** V3-01/02: a micro-lesson, and how I said I felt at the start. */
  kind: PeriodKind;
  energy: "low" | "ok" | "high" | null;
  /** V3-04: open parked thoughts in this School; this period's, at the bell. */
  parking: { open: number; items: ParkedItem[] };
  /** V3-05: a Pomodoro break is running until this time (the period is paused). */
  breakUntil: number | null;
  /** V4-01: two students talking to each other right now. */
  peer: { speakerId: string; listenerId: string } | null;
  /** V4-06: the corkboard, latest first. */
  stickers: StickerView[];
  /** V5: the student at the centre of a Socratic or teach-back period. */
  hotSeat: string | null;
  /** V5-04: the Connector's analogies and how I judged them. */
  analogy: {
    cadetId: string;
    cards: string[];
    results: Record<number, ServerMessageOf<"analogy.result">["payload"]>;
  } | null;
  /** V5-05: the ELI round I'm in, and each round's fit. */
  eli: {
    round: number;
    of: number;
    level: "eli5" | "eli15" | "expert";
    audience: string;
    scores: Array<{ round: number; score: number; feedback: string }>;
  } | null;
  /** V5-08: the substitute's lesson, my objections, then the result. */
  sub: {
    lines: string[];
    objections: Record<number, { planted: boolean; correction: string }>;
    result?: ServerMessageOf<"sub.result">["payload"];
  } | null;
  /** V6-08: the glossary wall, latest first. */
  glossary: Array<{ term: string; definition: string; agrees: boolean; note: string | null }>;
  /** V6-06: the passage of my sources I asked to see (to me only). */
  sourcePassage: ServerMessageOf<"source.passage">["payload"] | null;
  /** V5-09: the guest lecturer's latest answer (to me only). */
  guest: ServerMessageOf<"guest.answer">["payload"] | null;
  /** V5-03: the teach-back to mark, then its result. */
  teachBack: {
    cadetId: string;
    sentences: string[];
    result?: ServerMessageOf<"teachback.result">["payload"];
  } | null;
  /** T-10: Hyperfocus mode for this period. */
  hyperfocus: boolean;
  /** The exit-ticket minigame at the bell (M4-05). */
  exit?: ExitTicketsState;
  event?: EventState;
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
  board: "",
  lastTaughtDays: null,
  kind: "class",
  energy: null,
  parking: { open: 0, items: [] },
  breakUntil: null,
  peer: null,
  stickers: [],
  hotSeat: null,
  teachBack: null,
  analogy: null,
  eli: null,
  sub: null,
  guest: null,
  sourcePassage: null,
  glossary: [],
  hyperfocus: false,
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
        board: m.payload.board ?? "",
        lastTaughtDays: m.payload.lastTaughtDays ?? null,
        kind: m.payload.kind ?? "class",
        stickers: m.payload.stickers ?? [],
        hotSeat: m.payload.hotSeat ?? null,
        glossary: m.payload.glossary ?? [],
        energy: m.payload.energy ?? null,
        transcript: m.payload.transcript.map((t) => ({
          speaker: t.cadetId ? "cadet" : "headmaster",
          cadetId: t.cadetId,
          messageId: t.messageId,
          text: t.text,
        })),
      };
    case "asset.ready": {
      const { ownerType, ownerId, status, url } = m.payload;
      const c = ownerType === "cadet" && ownerId ? s.cadets[ownerId] : undefined;
      if (!c || status !== "ready") return s;
      return { ...s, cadets: { ...s.cadets, [c.id]: { ...c, portraitUrl: url } } };
    }
    case "exit.tickets":
      return {
        ...s,
        exit: {
          periodId: m.payload.periodId,
          conceptTitle: m.payload.conceptTitle,
          seconds: m.payload.seconds,
          at: now,
          tickets: m.payload.tickets.map((t) => ({ ...t })),
        },
      };
    case "exit.result":
      return s.exit
        ? {
            ...s,
            exit: {
              ...s.exit,
              tickets: s.exit.tickets.map((t) =>
                t.id === m.payload.ticketId
                  ? { ...t, right: m.payload.right, isTrue: m.payload.isTrue }
                  : t,
              ),
            },
          }
        : s;
    case "exit.summary":
      return s.exit?.periodId === m.payload.periodId
        ? { ...s, exit: { ...s.exit, summary: { ...m.payload } } }
        : s;
    case "xp.update":
      return {
        ...s,
        xp: m.payload.standing,
        xpGain: { delta: m.payload.delta, reason: m.payload.reason, at: now },
      };
    case "event.start":
      return {
        ...s,
        event: {
          id: m.payload.eventId,
          kind: m.payload.kind,
          ...(m.payload.cadetId ? { cadetId: m.payload.cadetId } : {}),
          text: m.payload.text,
          seconds: m.payload.seconds,
          at: now,
          ...(m.payload.toCadetId ? { toCadetId: m.payload.toCadetId } : {}),
        },
      };
    case "event.result": {
      if (s.event?.id !== m.payload.eventId) return s;
      const { score, caught, explanation, xp, feedback } = m.payload;
      const result = {
        explanation,
        xp,
        ...(feedback ? { feedback } : {}),
        ...(score !== undefined ? { score } : {}),
        ...(caught !== undefined ? { caught } : {}),
      };
      return { ...s, event: { ...s.event, sent: true, result } };
    }
    case "focus.changed":
      return { ...s, hyperfocus: m.payload.on };
    case "board.updated":
      return { ...s, board: m.payload.text };
    case "period.extended":
      return { ...s, plannedMinutes: m.payload.plannedMinutes };
    case "period.paused":
      return {
        ...s,
        clock: { elapsedMs: m.payload.elapsedMs, at: now, paused: m.payload.paused },
        speech: m.payload.paused && s.speech && !s.speech.done ? null : s.speech,
        thinking: false,
        breakUntil: m.payload.paused ? s.breakUntil : null,
      };
    case "cadet.joined":
      return {
        ...s,
        cadets: { ...s.cadets, [m.payload.cadet.id]: { ...m.payload.cadet } },
      };
    case "glossary.update":
      return { ...s, glossary: m.payload.terms };
    case "source.passage":
      return { ...s, sourcePassage: m.payload };
    case "guest.answer":
      return { ...s, guest: m.payload };
    case "analogy.cards":
      return { ...s, analogy: { ...m.payload, results: {} } };
    case "analogy.result":
      return s.analogy
        ? {
            ...s,
            analogy: { ...s.analogy, results: { ...s.analogy.results, [m.payload.i]: m.payload } },
          }
        : s;
    case "eli.round":
      return { ...s, eli: { ...m.payload, scores: s.eli?.scores ?? [] } };
    case "eli.scored":
      return s.eli ? { ...s, eli: { ...s.eli, scores: [...s.eli.scores, m.payload] } } : s;
    case "sub.lesson":
      return { ...s, sub: { lines: m.payload.lines, objections: {} } };
    case "sub.objection":
      return s.sub
        ? {
            ...s,
            sub: {
              ...s.sub,
              objections: {
                ...s.sub.objections,
                [m.payload.i]: { planted: m.payload.planted, correction: m.payload.correction },
              },
            },
          }
        : s;
    case "sub.result":
      return s.sub ? { ...s, sub: { ...s.sub, result: m.payload } } : s;
    case "teachback.ready":
      return { ...s, teachBack: { ...m.payload } };
    case "teachback.result":
      return s.teachBack ? { ...s, teachBack: { ...s.teachBack, result: m.payload } } : s;
    case "cadet.arc": {
      const c = s.cadets[m.payload.cadetId];
      if (!c?.arc) return s;
      const arc = { ...c.arc, stage: m.payload.stage, label: m.payload.label };
      return { ...s, cadets: { ...s.cadets, [c.id]: { ...c, arc } } };
    }
    case "sticker":
      return { ...s, stickers: [m.payload, ...s.stickers].slice(0, 12) };
    case "peer.started":
      return { ...s, peer: { ...m.payload } };
    case "peer.ended":
      return s.peer?.speakerId === m.payload.speakerId ? { ...s, peer: null } : s;
    case "period.recap":
      return m.payload.periodId === s.periodId ? { ...s, recap: m.payload.text } : s;
    case "turn.started":
      return {
        ...s,
        // The Dean counts my explanations while observing.
        ...(s.event?.kind === "inspector" && !s.event.result
          ? { event: { ...s.event, watched: Math.min(3, (s.event.watched ?? 0) + 1) } }
          : {}),
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
          ...(m.payload.mode ? { mode: m.payload.mode } : {}),
        },
        xp: m.payload.xp.standing,
        speech: null,
        hands: [],
      };
    // School setup progress is handled by the setup screens, not the classroom.
    case "pong":
    case "source.status":
    case "curriculum.status":
    case "registration.started":
    case "registration.arrival":
    case "registration.done":
    case "assignment.status":
    case "exam.status":
    case "exam.answer":
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
