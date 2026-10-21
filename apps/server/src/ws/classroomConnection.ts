import {
  ServerMessageZ,
  type CadetView,
  type ClientMessage,
  type GameConfig,
  type ReactionState,
  type ServerMessage,
} from "@lumen/shared";
import { and, eq } from "drizzle-orm";
import { writeRecap } from "../agents/realtime/recap.js";
import type { DbHandle } from "../db/client.js";
import { cadets, classrooms, ledgerEntries, schools } from "../db/schema.js";
import { ClassSession } from "../game/ClassSession.js";
import { rewriteNotes } from "../game/notes.js";
import {
  INSPECTION_TURNS,
  inspect,
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

  private async start(p: { classroomId: string; conceptId?: string; minutes?: number }) {
    if (this.session) await this.end();
    const { handle, game } = this.rt;
    const room = handle.db.select().from(classrooms).where(eq(classrooms.id, p.classroomId)).get();
    if (!room) throw new Error(`no classroom ${p.classroomId}`);
    const school = handle.db.select().from(schools).where(eq(schools.id, room.schoolId)).get()!;
    const minutes = p.minutes ?? game.period.defaultMinutes;
    const session = ClassSession.open(
      { handle, factory: this.rt.factory, game, embedder: this.rt.embedder, budget: this.rt.meter },
      { classroomId: room.id, conceptId: p.conceptId, plannedMinutes: minutes, resume: true },
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
      },
    });
    this.sendCost();
    if (this.rt.extras?.recaps !== false && !session.resumed) void this.sendRecap(session, room.id);
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
    const done = await turn.committed;
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
    if (!this.rt.game.events.enabled) return;
    const c = session.currentConcept;
    const ev = await maybeStartEvent({
      handle: this.rt.handle,
      factory: this.rt.factory,
      game: this.rt.game,
      periodId: session.periodId,
      classroomId: session.classroomId,
      concept: { id: c.id, title: c.title, keyFacts: c.keyFacts },
      turnOrd: session.turnCount,
      cadets: session.roster.map((r) => ({ id: r.id, name: r.name, archetype: r.archetype })),
    });
    if (!ev || this.session !== session) return;
    this.event = ev.kind === "pop_quiz" || ev.kind === "glitch" ? ev : null;
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
          reason: ev.kind === "pop_quiz" ? "Pop quiz" : "Caught the glitch",
          standing: standing(this.rt.handle, this.rt.game),
        },
      });
    this.sendCost();
  }

  private async call(cadetId: string) {
    const session = this.requireSession();
    const streamId = `str_${++this.streamSeq}`;
    const spoken = await session.speak(cadetId, {
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
    settleTeachingMinutes(handle, game, scope, session.elapsedMs());
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

  private cadetViews(session: ClassSession): CadetView[] {
    const { db } = this.rt.handle;
    const rows = db.select().from(cadets).where(eq(cadets.classroomId, session.classroomId)).all();
    return session.roster.map((r) => {
      const row = rows.find((x) => x.id === r.id)!;
      const ledger = db
        .select({ c: ledgerEntries.comprehension })
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
        comprehension: ledger?.c ?? 0,
        state: r.lastState as ReactionState,
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
