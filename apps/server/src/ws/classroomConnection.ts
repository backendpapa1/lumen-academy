import { askGuest, guestsLeft } from "../game/guest.js";
import { AnalogyLab, EliLadder, SubstituteLessonRunner, type ModeHost } from "./modeRunners.js";
import { withUsageContext } from "../usage/meter.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { TeachBackPhrasingZ } from "@lumen/shared";
import { callStructured } from "../agents/harness.js";
import { loadPrompt } from "../agents/prompts/load.js";
import {
  planTeachBack,
  scoreTeachBack,
  type TeachBackLine,
  type TeachBackScore,
} from "../game/teachBack.js";
import { resolveMisconceptions } from "../game/ledger.js";
import { isQuestion, socraticResult, type ModeResult } from "../game/modes.js";
import { ARCS, type Archetype, type ArcState } from "@lumen/shared";
import { interestsOf } from "../game/interests.js";
import { awardStickers, recentStickers } from "../game/stickers.js";

/** V4-03: the roster's arc line ({} for archetypes without one). */
function arcView(archetype: Archetype, state?: ArcState) {
  const arc = ARCS[archetype];
  if (!arc) return {};
  const stage = state?.stage ?? 0;
  return { arc: { stage, label: arc.stages[stage]?.label ?? "", trigger: arc.trigger } };
}
function arcLabel(
  students: ReadonlyArray<{ id: string; archetype: string; arc: ArcState }>,
  id: string,
) {
  const s = students.find((x) => x.id === id);
  return s ? (ARCS[s.archetype as Archetype]?.stages[s.arc.stage]?.label ?? "") : "";
}
import { hairOf } from "../game/looks.js";
import {
  ServerMessageZ,
  type CadetView,
  type ClientMessage,
  type GameConfig,
  type PeerBeat,
  type ReactionState,
  type ServerMessage,
} from "@lumen/shared";
import { and, eq } from "drizzle-orm";
import { writeRecap } from "../agents/realtime/recap.js";
import type { DbHandle } from "../db/client.js";
import { cadets, classrooms, ledgerEntries, schools } from "../db/schema.js";
import { ClassSession, type Energy, type PeriodKind } from "../game/ClassSession.js";
import { recall, retention } from "../game/memory.js";
import { rewriteNotes } from "../game/notes.js";
import {
  INSPECTION_TURNS,
  inspect,
  maybeRecheck,
  maybeStartEvent,
  resolveEvent,
  type PendingEvent,
} from "../game/events.js";
import { finishExitTickets, issueExitTickets, markExitTicket } from "../game/exitTickets.js";
import { awardXp, periodXp, settleTeachingMinutes, standing, type XpScope } from "../game/xp.js";
import type { AssetService } from "../assets/service.js";
import type { EventBus } from "../events.js";
import type { Embedder } from "../ingest/embed.js";
import type { ModelFactory } from "../models/factory.js";
import { BudgetPausedError, type UsageMeter } from "../usage/meter.js";
import { wsError } from "./handler.js";

// One WebSocket connection = one Headmaster at the lectern. Turns protocol
// messages into ClassSession calls and session events into protocol messages.

export interface Runtime {
  handle: DbHandle;
  factory: ModelFactory;
  meter: UsageMeter;
  game: GameConfig;
  embedder?: Embedder;
  /** Image generation; absent in tests and when no OpenAI key is set. */
  assets?: AssetService;
  /** Background job progress (School setup); buildApp creates one if absent. */
  bus?: EventBus;
  /** Recaps and notes are on by default; tests switch them off. */
  extras?: { recaps?: boolean; notes?: boolean };
  /** V1 voice: local speech in and out; absent when speech isn't configured. */
  speech?: import("../routes/speech.js").SpeechRuntime;
}

export const assetUrl = (id: string) => `/api/assets/${id}`;

export class ClassroomConnection {
  private session: ClassSession | null = null;
  private turnId: string | null = null;
  private lastSpeaker: { cadetId: string; turnsAgo: number; kind: string } | null = null;
  private scope: XpScope | null = null;
  /** The period that just ended, for its exit tickets. */
  private ended: { periodId: string; classroomId: string; schoolId: string } | null = null;
  private streamSeq = 0;
  /** The random event waiting for my answer (M6-01). */
  private event: PendingEvent | null = null;
  /** The Dean's visit: the explanations watched so far. */
  private schoolName: string | null = null;
  /** V5-04/05/08: the card-and-round modes. */
  private runner: {
    session: ClassSession;
    lab?: AnalogyLab;
    eli?: EliLadder;
    sub?: SubstituteLessonRunner;
  } | null = null;

  /** What a mode runner needs from this connection. */
  private host(): ModeHost {
    return {
      send: (m) => this.send(m),
      say: (cadetId, text, mood = "curious") => {
        const session = this.session;
        if (!session) return;
        const messageId = session.recordCadetUtterance(cadetId, text, "claim", {
          mode: session.kind,
        });
        const streamId = `str_${++this.streamSeq}`;
        this.send({ type: "cadet.stream", payload: { cadetId, streamId, delta: text } });
        this.send({
          type: "cadet.done",
          payload: { cadetId, streamId, messageId, text, kind: "claim", mood },
        });
      },
      handle: this.rt.handle,
      factory: this.rt.factory,
      game: this.rt.game,
      scope: this.scope,
    };
  }

  /** V5-03: the teach-back in this period, and its marks once I've checked it. */
  private teachBack: {
    session: ClassSession;
    lines: TeachBackLine[];
    sentences: string[];
    scored: boolean;
    result?: TeachBackScore;
  } | null = null;
  private inspection: {
    ev: PendingEvent;
    session: ClassSession;
    watched: Array<{ text: string; accuracy: number; clarity: number }>;
  } | null = null;
  private readonly unsubscribe: () => void;

  private readonly offAssets: () => void;
  private readonly offBus: () => void;

  constructor(
    private readonly rt: Runtime,
    private readonly sendRaw: (frame: string) => void,
  ) {
    this.offAssets =
      rt.assets?.onSettled((a) =>
        this.send({
          type: "asset.ready",
          payload: {
            assetId: a.id,
            kind: a.kind,
            ownerType: a.ownerType,
            ownerId: a.ownerId,
            status: a.status === "ready" ? "ready" : "error",
            url: a.status === "ready" ? assetUrl(a.id) : null,
          },
        }),
      ) ?? (() => {});
    this.offBus = rt.bus?.on((m) => this.send(m)) ?? (() => {});
    this.unsubscribe = rt.meter.onStateChange((state) => {
      const text = {
        warn: "You've used 80% of this month's AI budget.",
        degrade: "Budget nearly used: lighter models, and fewer cadets react each turn.",
        pause: "This month's AI budget is used up. Agents are paused.",
        ok: "Budget OK again.",
      }[state];
      this.send({ type: "toast", payload: { level: state === "ok" ? "info" : "warn", text } });
      this.sendCost();
    });
  }

  /** Every outgoing message is validated, so protocol drift fails loudly in tests. */
  private send(m: ServerMessage) {
    this.sendRaw(JSON.stringify(ServerMessageZ.parse(m)));
  }

  async handle(msg: ClientMessage): Promise<void> {
    try {
      switch (msg.type) {
        case "ping":
          return this.send({
            type: "pong",
            payload: { nonce: msg.payload.nonce, serverTime: new Date().toISOString() },
          });
        case "period.start":
          return await this.start(msg.payload);
        case "teach.message":
          return await this.teach(msg.payload.text, msg.payload.replyToCadetId);
        case "hand.call":
          return await this.call(msg.payload.cadetId);
        case "concept.set":
          this.requireSession().setConcept(msg.payload.conceptId);
          return;
        case "period.pause":
        case "period.resume": {
          const session = this.requireSession();
          if (msg.type === "period.pause") session.pause();
          else session.resume();
          return this.send({
            type: "period.paused",
            payload: { paused: session.paused, elapsedMs: session.elapsedMs() },
          });
        }
        case "focus.toggle": {
          this.requireSession().hyperfocus = msg.payload.on;
          return this.send({ type: "focus.changed", payload: { on: msg.payload.on } });
        }
        case "board.set": {
          const text = this.requireSession().setBoard(msg.payload.text);
          return this.send({ type: "board.updated", payload: { text } });
        }
        case "period.extend": {
          const plannedMinutes = this.requireSession().extend(msg.payload.minutes);
          return this.send({ type: "period.extended", payload: { plannedMinutes } });
        }
        case "period.end":
          return await this.end();
        case "event.answer":
          return await this.answerEvent(msg.payload);
        case "exit.mark": {
          const r = markExitTicket(this.rt.handle, msg.payload);
          if (r)
            this.send({ type: "exit.result", payload: { ticketId: msg.payload.ticketId, ...r } });
          return;
        }
        case "guest.invite":
          return await this.inviteGuest(msg.payload.question);
        case "analogy.judge":
          if (this.runner?.session === this.session)
            await this.runner.lab?.judge(msg.payload.i, msg.payload.verdict, msg.payload.reason);
          return;
        case "sub.object":
          if (this.runner?.session === this.session) this.runner.sub?.object(msg.payload.i);
          return;
        case "sub.finish":
          if (this.runner?.session === this.session) this.runner.sub?.finish();
          return;
        case "teachback.mark":
          return this.markTeachBack(msg.payload.wrong);
        case "exit.done": {
          const e = this.ended;
          if (!e || e.periodId !== msg.payload.periodId) return;
          const s = finishExitTickets(this.rt.handle, this.rt.game, e);
          this.send({ type: "exit.summary", payload: { periodId: e.periodId, ...s } });
          if (s.xp)
            this.send({
              type: "xp.update",
              payload: {
                delta: s.xp,
                reason: "Exit ticket",
                standing: standing(this.rt.handle, this.rt.game),
              },
            });
          return;
        }
      }
    } catch (err) {
      if (err instanceof BudgetPausedError) {
        this.send(wsError("budget_paused", err.message));
        return;
      }
      this.send(wsError("failed", (err as Error).message ?? String(err)));
    }
  }

  private closing: Promise<void> | null = null;

  /**
   * Idempotent: socket close and server shutdown may both call it. A running
   * period is suspended, not ended: reopening the classroom continues it.
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.unsubscribe();
      this.offAssets();
      this.offBus();
      const session = this.session;
      this.session = null;
      if (session) await session.suspend();
    })();
    return this.closing;
  }

  // --- handlers ---------------------------------------------------------------

  private requireSession(): ClassSession {
    if (!this.session) throw new Error("no class period is running; send period.start first");
    return this.session;
  }

  private async start(p: {
    classroomId: string;
    conceptId?: string;
    minutes?: number;
    kind?: PeriodKind;
    cadetId?: string;
    energy?: Energy;
  }) {
    if (this.session) await this.end();
    const { handle, game } = this.rt;
    const room = handle.db.select().from(classrooms).where(eq(classrooms.id, p.classroomId)).get();
    if (!room) throw new Error(`no classroom ${p.classroomId}`);
    const school = handle.db.select().from(schools).where(eq(schools.id, room.schoolId)).get()!;
    const minutes = p.minutes ?? game.period.defaultMinutes;
    const session = ClassSession.open(
      { handle, factory: this.rt.factory, game, embedder: this.rt.embedder, budget: this.rt.meter },
      {
        classroomId: room.id,
        conceptId: p.conceptId,
        plannedMinutes: minutes,
        resume: true,
        kind: p.kind,
        cadetId: p.cadetId,
        energy: p.energy,
      },
      {
        onReaction: (cadetId, state) =>
          this.turnId &&
          this.send({ type: "crowd.reaction", payload: { turnId: this.turnId, cadetId, state } }),
        onHands: (queue) =>
          this.send({
            type: "hands.update",
            payload: {
              queue: queue.map(({ cadetId, intent, preview, urgency }) => ({
                cadetId,
                intent,
                preview,
                urgency,
              })),
            },
          }),
        onConceptChange: (id, title) =>
          this.send({ type: "concept.changed", payload: { id, title } }),
        onRewrite: (messageId, cadetId, text) =>
          this.send({ type: "cadet.rewrite", payload: { messageId, cadetId, text } }),
        onPeerBeat: (beat) => void this.runPeer(beat).catch(() => undefined),
        onArc: (cadetId, stage, moment) =>
          this.send({
            type: "cadet.arc",
            payload: { cadetId, stage, label: arcLabel(session.flavour, cadetId), moment },
          }),
        onError: (stage) =>
          this.send({
            type: "toast",
            payload: {
              level: "warn",
              text:
                stage === "director"
                  ? "The class lost the thread for a moment; that turn counts lightly."
                  : `Something hiccuped (${stage}); carrying on.`,
            },
          }),
      },
    );
    this.session = session;
    this.scope = { schoolId: school.id, classroomId: room.id, periodId: session.periodId };
    this.schoolName = school.name;
    this.send({
      type: "period.started",
      payload: {
        periodId: session.periodId,
        school: { id: school.id, name: school.name },
        classroom: { id: room.id, name: room.name },
        concept: { id: session.currentConcept.id, title: session.currentConcept.title },
        concepts: session.concepts.map((c) => ({ id: c.id, title: c.title })),
        cadets: this.cadetViews(session),
        plannedMinutes: session.plannedMinutes,
        elapsedMs: Math.round(session.elapsedMs()),
        resumed: session.resumed,
        paused: session.paused,
        ...(session.resumed && session.board ? { board: session.board } : {}),
        transcript: session.resumed ? this.transcriptView(session.periodId) : [],
        xp: standing(handle, game),
        lastTaughtDays: this.lastTaughtDays(room.id, session.currentConcept.id),
        kind: session.kind,
        energy: session.energy,
        stickers: recentStickers(handle, room.id),
        hotSeat: session.hotSeat,
      },
    });
    this.sendCost();
    if (this.rt.extras?.recaps !== false && !session.resumed) void this.sendRecap(session, room.id);
    if (session.kind === "teach_back") void this.runTeachBack(session).catch(() => undefined);
    const failed = (what: string) => () =>
      this.send({
        type: "toast",
        payload: { level: "warn", text: `${what} didn't come through. Try starting again.` },
      });
    if (session.kind === "analogy_lab") {
      const lab = new AnalogyLab(this.host(), session);
      this.runner = { session, lab };
      void lab.start().catch(failed("The analogies"));
    }
    if (session.kind === "eli_ladder") {
      const eli = new EliLadder(this.host(), session);
      this.runner = { session, eli };
      eli.start();
    }
    if (session.kind === "substitute") {
      const sub = new SubstituteLessonRunner(this.host(), session);
      this.runner = { session, sub };
      void sub.start().catch(failed("The substitute's lesson"));
    }
  }

  private async sendRecap(session: ClassSession, classroomId: string) {
    const { sqlite } = this.rt.handle;
    const prev = sqlite
      .prepare(
        "SELECT id FROM periods WHERE classroom_id = ? AND ended_at IS NOT NULL AND id != ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(classroomId, session.periodId) as { id: string } | undefined;
    if (!prev) return;
    const lines = (
      sqlite
        .prepare(
          "SELECT text FROM messages WHERE period_id = ? AND speaker = 'teacher' ORDER BY created_at",
        )
        .all(prev.id) as { text: string }[]
    ).map((r) => r.text);
    try {
      const text = await writeRecap(this.rt.factory, {
        kind: "in",
        teacherLines: lines,
        weakConcepts: [],
      });
      sqlite.prepare("UPDATE periods SET recap_in = ? WHERE id = ?").run(text, session.periodId);
      if (this.session === session)
        this.send({ type: "period.recap", payload: { periodId: session.periodId, text } });
    } catch {
      /* a recap is a nicety; never block or fail the class for it */
    }
  }

  private async teach(text: string, replyTo?: string) {
    const session = this.requireSession();
    // V5-08: with a substitute in, I'm at the back: I object, I don't teach.
    if (session.kind === "substitute")
      return this.send({
        type: "toast",
        payload: {
          level: "info",
          text: "You're at the back today: press Object when you hear a mistake.",
        },
      });
    // V5-02: a Socratic class takes questions only. Nothing is saved or charged.
    if (session.kind === "socratic" && !isQuestion(text))
      return this.send({
        type: "toast",
        payload: { level: "info", text: "Try asking instead: turn that into a question." },
      });
    // Speaking right after a cadet counts as answering them (as in cli:teach).
    const reply =
      replyTo ??
      (this.lastSpeaker && this.lastSpeaker.turnsAgo === 0 ? this.lastSpeaker.cadetId : undefined);
    const answering =
      !!reply &&
      this.lastSpeaker?.cadetId === reply &&
      this.lastSpeaker.turnsAgo === 0 &&
      ["question", "objection", "claim"].includes(this.lastSpeaker.kind);
    const turn = session.teach(text, reply ? { replyToCadetId: reply } : {});
    this.turnId = turn.turnId;
    if (answering && this.scope) {
      const delta = awardXp(this.rt.handle, this.rt.game, this.scope, "questionAnswered");
      if (delta)
        this.send({
          type: "xp.update",
          payload: {
            delta,
            reason: "Answered a question",
            standing: standing(this.rt.handle, this.rt.game),
          },
        });
    }
    if (this.lastSpeaker) this.lastSpeaker.turnsAgo++;
    this.send({ type: "turn.started", payload: { turnId: turn.turnId, text } });
    const reaction = await turn.reaction;
    this.send({
      type: "crowd.done",
      payload: { turnId: turn.turnId, firstReactionMs: reaction?.firstReactionMs ?? null },
    });
    // V5-02: the student in the hot seat answers my question straight away.
    if (session.kind === "socratic" && session.hotSeat && this.turnId === turn.turnId)
      void this.call(session.hotSeat, { answer: text }).catch(() => undefined);
    const done = await turn.committed;
    // V5-05: each explanation in the ELI ladder is judged for its audience; after
    // the expert round, the Skeptic (or the Overachiever) presses me on it.
    if (session.kind === "eli_ladder" && this.runner?.eli && this.runner.session === session)
      void this.runner.eli.explained(text).then((r) => {
        if (!r?.expertDone || this.session !== session) return;
        const expert =
          session.flavour.find((f) => f.archetype === "skeptic") ??
          session.flavour.find((f) => f.archetype === "overachiever");
        if (expert) void this.call(expert.id).catch(() => undefined);
      });
    // V4-06: stickers for great moments, by server rules on the Director's report.
    if (this.scope)
      for (const s of awardStickers(this.rt.handle, this.rt.game, {
        periodId: session.periodId,
        classroomId: session.classroomId,
        text,
        analysis: done.analysis,
        changes: done.changes,
        students: [...session.flavour],
      }))
        this.send({ type: "sticker", payload: s });
    const conceptId = done.analysis.conceptIds[0] ?? session.currentConcept.id;
    const forConcept = done.changes.filter((c) => c.conceptId === conceptId);
    if (forConcept.length) {
      this.send({
        type: "ledger.update",
        payload: {
          turnId: turn.turnId,
          conceptId,
          cadets: forConcept.map((c) => ({ cadetId: c.cadetId, comprehension: c.comprehension })),
          classAverage: forConcept.reduce((a, c) => a + c.comprehension, 0) / forConcept.length,
        },
      });
    }
    this.sendCost();
    if (this.inspection?.session === session) {
      const t = done.analysis.teaching;
      this.inspection.watched.push({ text, accuracy: t.accuracy, clarity: t.clarity });
      if (this.inspection.watched.length >= INSPECTION_TURNS) void this.finishInspection();
    } else if (!this.event) void this.startEvent(session).catch(() => {});
  }

  private async finishInspection() {
    const insp = this.inspection;
    if (!insp) return;
    this.inspection = null;
    try {
      const r = await inspect(
        insp.ev,
        insp.watched,
        insp.session.currentConcept.title,
        this.rt.factory,
      );
      this.send({
        type: "event.result",
        payload: { eventId: insp.ev.id, kind: "inspector", ...r },
      });
    } catch (err) {
      if (err instanceof BudgetPausedError)
        return void this.send(wsError("budget_paused", err.message));
      this.send({
        type: "toast",
        payload: { level: "warn", text: "The Dean left without a report this time." },
      });
    }
    this.sendCost();
  }

  /** At most one random event per period, after a teaching turn commits. */
  private async startEvent(session: ClassSession) {
    const c = session.currentConcept;
    const ctx = {
      handle: this.rt.handle,
      factory: this.rt.factory,
      game: this.rt.game,
      periodId: session.periodId,
      classroomId: session.classroomId,
      concept: { id: c.id, title: c.title, keyFacts: c.keyFacts },
      turnOrd: session.turnCount,
      cadets: session.roster.map((r) => ({ id: r.id, name: r.name, archetype: r.archetype })),
    };
    let ev = this.rt.game.events.enabled && !session.quiet ? await maybeStartEvent(ctx) : null;
    // V2-05: the mistake journal isn't a surprise, so it runs even with events off.
    if (!ev && !this.event && !this.inspection) ev = maybeRecheck(ctx);
    if (!ev || this.session !== session) return;
    this.event =
      ev.kind === "pop_quiz" ||
      ev.kind === "glitch" ||
      ev.kind === "recheck" ||
      ev.kind === "debate"
        ? ev
        : null;
    if (ev.kind === "inspector") this.inspection = { ev, session, watched: [] };
    this.send({
      type: "event.start",
      payload: {
        eventId: ev.id,
        kind: ev.kind,
        ...(ev.cadetId ? { cadetId: ev.cadetId } : {}),
        text: ev.text,
        seconds: ev.seconds,
        ...(ev.toCadetId ? { toCadetId: ev.toCadetId } : {}),
      },
    });
    // V5-11: a transfer student takes a seat; a debate's two sides speak.
    if (ev.kind === "transfer" && ev.cadetId) {
      session.admit(ev.cadetId);
      const view = this.cadetViews(session).find((c) => c.id === ev.cadetId);
      if (view) this.send({ type: "cadet.joined", payload: { cadet: view } });
    }
    if (ev.kind === "debate" && ev.cadetId && ev.toCadetId)
      void this.runDebate(session, ev.cadetId, ev.toCadetId, ev.text).catch(() => undefined);
    this.sendCost();
  }

  private async answerEvent(a: { eventId: string; text?: string; wrong?: boolean }) {
    const ev = this.event;
    if (!ev || ev.id !== a.eventId || !this.scope) return;
    this.event = null;
    const r = await resolveEvent(ev, a, {
      handle: this.rt.handle,
      factory: this.rt.factory,
      game: this.rt.game,
      scope: this.scope,
    });
    this.send({ type: "event.result", payload: { eventId: ev.id, kind: ev.kind, ...r } });
    if (r.xp)
      this.send({
        type: "xp.update",
        payload: {
          delta: r.xp,
          reason:
            ev.kind === "pop_quiz"
              ? "Pop quiz"
              : ev.kind === "debate"
                ? "Ruled the debate"
                : "Caught the glitch",
          standing: standing(this.rt.handle, this.rt.game),
        },
      });
    this.sendCost();
  }

  private async call(cadetId: string, opts: { answer?: string } = {}) {
    const session = this.requireSession();
    const streamId = `str_${++this.streamSeq}`;
    const spoken = await session.speak(cadetId, {
      ...opts,
      onDelta: (delta) =>
        this.send({ type: "cadet.stream", payload: { cadetId, streamId, delta } }),
    });
    if (!spoken) return this.send({ type: "cadet.interrupted", payload: { cadetId, streamId } });
    this.lastSpeaker = { cadetId, turnsAgo: 0, kind: spoken.utterance.kind };
    this.send({
      type: "cadet.done",
      payload: {
        cadetId,
        streamId,
        messageId: spoken.messageId,
        text: spoken.utterance.text,
        kind: spoken.utterance.kind,
        mood: spoken.utterance.mood,
      },
    });
    void spoken.guard.then(() => this.sendCost());
  }

  /**
   * V4-01 (VD9): a short exchange between two students. Each line is written
   * with that student's own knowledge and passes the Leak Guard before the
   * other hears it. Anything I say cuts it off (teach() interrupts).
   */
  private async runPeer(beat: PeerBeat) {
    const session = this.session;
    if (!session) return;
    const { speakerId, listenerId } = beat;
    const line = async (
      cadetId: string,
      peer: { role: "explain" | "reply"; toId: string; preview?: string; said?: string },
    ) => {
      const streamId = `str_${++this.streamSeq}`;
      const spoken = await session.speak(cadetId, {
        peer,
        onDelta: (delta) =>
          this.send({ type: "cadet.stream", payload: { cadetId, streamId, delta } }),
      });
      if (!spoken) {
        this.send({ type: "cadet.interrupted", payload: { cadetId, streamId } });
        return null;
      }
      this.send({
        type: "cadet.done",
        payload: {
          cadetId,
          streamId,
          messageId: spoken.messageId,
          text: spoken.utterance.text,
          kind: spoken.utterance.kind,
          mood: spoken.utterance.mood,
        },
      });
      // The other student hears what survives the Leak Guard, never a leak.
      return (await spoken.guard).text;
    };
    this.send({ type: "peer.started", payload: { speakerId, listenerId } });
    try {
      const said = await line(speakerId, {
        role: "explain",
        toId: listenerId,
        preview: beat.preview,
      });
      if (said && this.session === session) {
        void session.gradePeer(listenerId, said);
        await line(listenerId, { role: "reply", toId: speakerId, said });
      }
    } finally {
      if (this.session === session)
        this.send({ type: "peer.ended", payload: { speakerId, listenerId } });
      this.sendCost();
    }
  }

  /**
   * V5-03: the hot-seat student explains the concept back. The statements come
   * from their own pack (true = retained, false = misconception); the LLM only
   * phrases them, and any phrasing that adds terms falls back to the statement.
   */
  private async runTeachBack(session: ClassSession) {
    const cadetId = session.hotSeat;
    if (!cadetId) return;
    const c = session.currentConcept;
    const row = this.rt.handle.db.select().from(cadets).where(eq(cadets.id, cadetId)).get()!;
    const lines = planTeachBack(this.rt.handle, this.rt.game, {
      classroomId: session.classroomId,
      cadetId,
      periodId: session.periodId,
      concept: c,
    });
    if (!lines.length) {
      // Nothing taught, nothing to explain back: the student says so, honestly.
      const text = `We haven't really done "${c.title}" yet. Could you teach it first?`;
      const messageId = session.recordTeachBack(cadetId, text);
      const streamId = `str_${++this.streamSeq}`;
      this.send({ type: "cadet.stream", payload: { cadetId, streamId, delta: text } });
      this.send({
        type: "cadet.done",
        payload: { cadetId, streamId, messageId, text, kind: "answer", mood: "sheepish" },
      });
      return;
    }
    let sentences = lines.map((l) => l.text);
    try {
      const res = await withUsageContext({ periodId: session.periodId }, () =>
        callStructured(this.rt.factory, "teachBack", {
          schema: TeachBackPhrasingZ,
          name: "teach_back",
          messages: [
            new SystemMessage(
              loadPrompt("teachBack", {
                name: row.name,
                voiceNotes: row.voiceNotes,
                conceptTitle: c.title,
                count: lines.length,
                statements: lines.map((l, i) => `${i + 1}. ${l.text}`).join("\n"),
              }),
            ),
            new HumanMessage("Explain it back."),
          ],
        }),
      );
      if (res.data.sentences.length === lines.length)
        sentences = res.data.sentences.map((s, i) =>
          session.addsTerms(s, lines[i]!.text) ? lines[i]!.text : s,
        );
    } catch {
      /* the plain statements still make a teach-back */
    }
    if (this.session !== session) return;
    this.teachBack = { session, lines, sentences, scored: false };
    const text = sentences.join(" ");
    const messageId = session.recordTeachBack(cadetId, text);
    const streamId = `str_${++this.streamSeq}`;
    this.send({ type: "cadet.stream", payload: { cadetId, streamId, delta: text } });
    this.send({
      type: "cadet.done",
      payload: { cadetId, streamId, messageId, text, kind: "answer", mood: "curious" },
    });
    this.send({ type: "teachback.ready", payload: { cadetId, sentences } });
    this.sendCost();
  }

  private markTeachBack(wrong: number[]) {
    const tb = this.teachBack;
    if (!tb || tb.session !== this.session || tb.scored) return;
    tb.scored = true;
    const s = scoreTeachBack(tb.lines, wrong);
    tb.result = s;
    const marked = new Set(wrong);
    // The misconceptions I caught are corrected for that student.
    const caught = tb.lines.filter((l, i) => !l.true && marked.has(i)).map((l) => l.text);
    if (caught.length && tb.session.hotSeat)
      resolveMisconceptions(
        this.rt.handle,
        tb.session.hotSeat,
        tb.session.currentConcept.id,
        caught,
      );
    if (this.scope && s.caught)
      awardXp(this.rt.handle, this.rt.game, this.scope, "teachBackCatch", s.caught);
    this.send({
      type: "teachback.result",
      payload: {
        lines: tb.lines.map((l, i) => ({
          text: tb.sentences[i]!,
          true: l.true,
          marked: marked.has(i),
        })),
        ...s,
      },
    });
  }

  /**
   * V5-09: the guest lecturer answers the class's question from my sources.
   * Their words go to me only: never into the session transcript, a pack,
   * notes or recall, so knowledge gating holds.
   */
  private async inviteGuest(question?: string) {
    const session = this.requireSession();
    const { handle, game, factory, embedder } = this.rt;
    const toast = (text: string, level: "info" | "warn" = "info") =>
      this.send({ type: "toast", payload: { level, text } });
    if (!game.modes.guest) return toast("The guest lecturer is switched off in game.yaml.");
    if (!embedder)
      return toast("The guest lecturer needs an OpenAI key in .env to search your sources.");
    const left = guestsLeft(handle, game);
    if (left <= 0) return toast("No guest visits left this week. They're back in a few days.");
    // The class's latest question if I didn't give one.
    const q =
      question?.trim() ||
      session.handQueue[0]?.preview ||
      [...session.lines].reverse().find((l) => l.speaker !== "Teacher")?.text;
    if (!q) return toast("Ask the guest something: /guest <question>.");
    toast("The guest lecturer is on their way…");
    try {
      const g = await withUsageContext({ periodId: session.periodId }, () =>
        askGuest(
          { handle, factory, embedder },
          {
            schoolId: this.scope?.schoolId ?? "",
            schoolName: this.schoolName ?? "",
            periodId: session.periodId,
            question: q,
          },
        ),
      );
      this.send({ type: "guest.answer", payload: { ...g, left: left - 1 } });
    } catch (err) {
      toast((err as Error).message, "warn");
    }
    this.sendCost();
  }

  /** V5-11: the believer argues for the claim, the other answers them; then I rule. */
  private async runDebate(session: ClassSession, forId: string, againstId: string, claim: string) {
    const line = async (
      cadetId: string,
      debate: { stance: "for" | "against"; claim: string; heard?: string },
    ) => {
      const streamId = `str_${++this.streamSeq}`;
      const spoken = await session.speak(cadetId, {
        debate,
        onDelta: (delta) =>
          this.send({ type: "cadet.stream", payload: { cadetId, streamId, delta } }),
      });
      if (!spoken) return null;
      this.send({
        type: "cadet.done",
        payload: {
          cadetId,
          streamId,
          messageId: spoken.messageId,
          text: spoken.utterance.text,
          kind: spoken.utterance.kind,
          mood: spoken.utterance.mood,
        },
      });
      return (await spoken.guard).text;
    };
    const said = await line(forId, { stance: "for", claim });
    if (said && this.session === session)
      await line(againstId, { stance: "against", claim, heard: said });
  }

  /** V5: the mode's own result for the bell card. */
  private modeResult(session: ClassSession): ModeResult | null {
    if (session.kind === "socratic") {
      const seat = session.hotSeat ? session.roster.find((r) => r.id === session.hotSeat) : null;
      const now = seat ? this.comprehensionOf(seat.id, session.currentConcept.id) : 0;
      return socraticResult(
        this.rt.handle,
        session.periodId,
        seat ? { name: seat.name, before: session.hotSeatStart, after: now } : null,
      );
    }
    if (this.runner?.session === session) {
      const r = this.runner.lab ?? this.runner.eli ?? this.runner.sub;
      if (r) return r.result();
    }
    if (session.kind === "teach_back") {
      const r = this.teachBack?.session === session ? this.teachBack.result : undefined;
      return {
        kind: "teach_back",
        title: "Teach-back",
        lines: r
          ? [
              `You caught ${r.caught} of ${r.caught + r.missed} mistake${r.caught + r.missed === 1 ? "" : "s"}${r.falseAlarms ? `, with ${r.falseAlarms} false alarm${r.falseAlarms === 1 ? "" : "s"}` : ", with no false alarms"}.`,
              r.missed
                ? "The ones you missed are mix-ups your class still holds."
                : "Nothing slipped past you.",
            ]
          : ["The teach-back wasn't marked this time."],
        ...(r ? { score: r.score } : {}),
      };
    }
    return null;
  }

  private comprehensionOf(cadetId: string, conceptId: string): number {
    const row = this.rt.handle.sqlite
      .prepare("SELECT comprehension c FROM ledger_entries WHERE cadet_id = ? AND concept_id = ?")
      .get(cadetId, conceptId) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  private async end() {
    const session = this.requireSession();
    this.session = null;
    await session.close();
    const { handle, game } = this.rt;
    const before = standing(handle, game);
    const scope = this.scope ?? {
      schoolId: "",
      classroomId: session.classroomId,
      periodId: session.periodId,
    };
    // V3-01: a micro-lesson earns a flat, smaller award instead of per-minute XP.
    if (session.kind === "micro") {
      if (session.turnCount > 0) awardXp(handle, game, scope, "microLesson");
    } else settleTeachingMinutes(handle, game, scope, session.elapsedMs());
    const breakdown = periodXp(handle, session.periodId);
    const after = standing(handle, game);
    const { sqlite } = this.rt.handle;
    const taught = session.lines.filter((l) => l.speaker === "Teacher").map((l) => l.text);
    const idx = session.concepts.findIndex((c) => c.id === session.currentConcept.id);
    const [recapOut] = await Promise.all([
      this.rt.extras?.recaps !== false && taught.length
        ? writeRecap(this.rt.factory, {
            kind: "out",
            teacherLines: taught,
            weakConcepts: [],
            nextConcept: session.concepts[idx + 1]?.title,
          }).catch(() => undefined)
        : Promise.resolve(undefined),
      this.rt.extras?.notes !== false
        ? rewriteNotes(
            { handle: this.rt.handle, factory: this.rt.factory },
            { periodId: session.periodId, classroomId: session.classroomId },
          )
        : Promise.resolve(null),
    ]);
    if (recapOut)
      sqlite
        .prepare("UPDATE periods SET recap_out = ? WHERE id = ?")
        .run(recapOut, session.periodId);
    const mode = this.modeResult(session);
    const turns = (
      sqlite.prepare("SELECT count(*) n FROM turns WHERE period_id = ?").get(session.periodId) as {
        n: number;
      }
    ).n;
    this.send({
      type: "period.ended",
      payload: {
        periodId: session.periodId,
        turns,
        minutes: Math.round(session.periodMinute()),
        costUsd: this.rt.meter.totals(session.periodId).periodUsd ?? 0,
        ...(recapOut ? { recapOut } : {}),
        ...(mode ? { mode } : {}),
        xp: {
          earned: breakdown.reduce((a, b) => a + b.amount, 0),
          breakdown,
          standing: after,
          rankedUp: after.rank !== before.rank,
        },
      },
    });
    // Exit ticket (M4-05): a minute of ✓/✗ on what each cadet thinks they learned.
    this.ended = {
      periodId: session.periodId,
      classroomId: session.classroomId,
      schoolId: scope.schoolId,
    };
    if (turns > 0) {
      const tickets = issueExitTickets(handle, {
        periodId: session.periodId,
        classroomId: session.classroomId,
        conceptId: session.currentConcept.id,
        memory: this.rt.game.memory,
        ...(session.kind === "micro" ? { cadetIds: session.roster.map((r) => r.id) } : {}),
      });
      if (tickets.length)
        this.send({
          type: "exit.tickets",
          payload: {
            periodId: session.periodId,
            conceptTitle: session.currentConcept.title,
            seconds: 60,
            tickets,
          },
        });
    }
  }

  // --- views ------------------------------------------------------------------

  /** The dialogue so far, for a resumed period. */
  private transcriptView(periodId: string) {
    const rows = this.rt.handle.sqlite
      .prepare(
        `SELECT m.id, m.speaker, m.text, c.name FROM messages m LEFT JOIN cadets c ON c.id = m.speaker
         WHERE m.period_id = ? AND m.kind IN ('lecture','answer','question','objection','claim')
         ORDER BY m.created_at, m.rowid`,
      )
      .all(periodId) as Array<{ id: string; speaker: string; text: string; name: string | null }>;
    return rows.map((r) =>
      r.speaker === "teacher"
        ? { speaker: "Teacher", messageId: r.id, text: r.text }
        : { speaker: r.name ?? "Student", cadetId: r.speaker, messageId: r.id, text: r.text },
    );
  }

  /** V2-04: how long ago this class last heard about this concept. */
  private lastTaughtDays(classroomId: string, conceptId: string): number | null {
    const row = this.rt.handle.sqlite
      .prepare(
        `SELECT max(l.last_taught_at) AS at FROM ledger_entries l JOIN cadets d ON d.id = l.cadet_id
         WHERE d.classroom_id = ? AND l.concept_id = ?`,
      )
      .get(classroomId, conceptId) as { at: string | null } | undefined;
    return row?.at ? Math.floor((Date.now() - Date.parse(row.at)) / 86_400_000) : null;
  }

  private cadetViews(session: ClassSession): CadetView[] {
    const { db } = this.rt.handle;
    const rows = db.select().from(cadets).where(eq(cadets.classroomId, session.classroomId)).all();
    return session.roster.map((r) => {
      const row = rows.find((x) => x.id === r.id)!;
      const ledger = db
        .select({
          c: ledgerEntries.comprehension,
          at: ledgerEntries.lastTaughtAt,
          s: ledgerEntries.stabilityDays,
        })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.cadetId, r.id),
            eq(ledgerEntries.conceptId, session.currentConcept.id),
          ),
        )
        .get();
      return {
        id: r.id,
        name: r.name,
        archetype: r.archetype,
        seat: row.seat,
        homeworld: row.homeworld,
        quirk: row.quirk,
        portraitUrl: this.portraitUrl(row.portraitAssetId),
        hair: hairOf(row.traitsJson),
        interests: interestsOf(row.interestsJson),
        ...arcView(row.archetype as Archetype, session.flavour.find((f) => f.id === r.id)?.arc),
        // What they recall today (V2 forgetting), not the old peak.
        comprehension: ledger
          ? recall(ledger.c, ledger.at, ledger.s, new Date(), this.rt.game.memory)
          : 0,
        // A student who's let it slip starts the class looking unsure (V2-04).
        state:
          r.lastState === "attentive" &&
          ledger &&
          ledger.c > 0 &&
          retention(ledger.at, ledger.s, new Date(), this.rt.game.memory) <
            this.rt.game.memory.fadingAt
            ? "confused"
            : (r.lastState as ReactionState),
      };
    });
  }

  private portraitUrl(assetId: string | null): string | null {
    if (!assetId) return null;
    const a = this.rt.handle.sqlite
      .prepare("SELECT status FROM assets WHERE id = ?")
      .get(assetId) as { status: string } | undefined;
    return a?.status === "ready" ? assetUrl(assetId) : null;
  }

  private sendCost() {
    const t = this.rt.meter.totals(this.session?.periodId);
    this.send({
      type: "cost.update",
      payload: {
        periodUsd: t.periodUsd ?? 0,
        dayUsd: t.dayUsd,
        monthUsd: t.monthUsd,
        capUsd: t.capUsd,
        state: this.rt.meter.budgetState(),
      },
    });
  }
}
