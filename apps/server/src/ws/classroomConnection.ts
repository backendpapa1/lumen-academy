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
  /** Recaps and notes are on by default; tests switch them off. */
  extras?: { recaps?: boolean; notes?: boolean };
}

export class ClassroomConnection {
  private session: ClassSession | null = null;
  private turnId: string | null = null;
  private lastSpeaker: { cadetId: string; turnsAgo: number } | null = null;
  private streamSeq = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly rt: Runtime,
    private readonly sendRaw: (frame: string) => void,
  ) {
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
        case "period.end":
          return await this.end();
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

  /** Idempotent: socket close and server shutdown may both call it. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.unsubscribe();
      const session = this.session;
      this.session = null;
      if (session) await session.close();
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
      { classroomId: room.id, conceptId: p.conceptId, plannedMinutes: minutes },
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
    this.send({
      type: "period.started",
      payload: {
        periodId: session.periodId,
        school: { id: school.id, name: school.name },
        classroom: { id: room.id, name: room.name },
        concept: { id: session.currentConcept.id, title: session.currentConcept.title },
        concepts: session.concepts.map((c) => ({ id: c.id, title: c.title })),
        cadets: this.cadetViews(session),
        plannedMinutes: minutes,
        transcript: [],
      },
    });
    this.sendCost();
    if (this.rt.extras?.recaps !== false) void this.sendRecap(session, room.id);
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
    const turn = session.teach(text, reply ? { replyToCadetId: reply } : {});
    this.turnId = turn.turnId;
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
  }

  private async call(cadetId: string) {
    const session = this.requireSession();
    const streamId = `str_${++this.streamSeq}`;
    const spoken = await session.speak(cadetId, {
      onDelta: (delta) =>
        this.send({ type: "cadet.stream", payload: { cadetId, streamId, delta } }),
    });
    if (!spoken) return this.send({ type: "cadet.interrupted", payload: { cadetId, streamId } });
    this.lastSpeaker = { cadetId, turnsAgo: 0 };
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
    const { sqlite } = this.rt.handle;
    const taught = session.lines.filter((l) => l.speaker === "Headmaster").map((l) => l.text);
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
      },
    });
  }

  // --- views ------------------------------------------------------------------

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
        comprehension: ledger?.c ?? 0,
        state: r.lastState as ReactionState,
      };
    });
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
