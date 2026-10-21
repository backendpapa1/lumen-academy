import { modeInfo, type PeriodKind } from "@lumen/shared";
import { arcMoment, arcPrompt, arcStep, parseArc, type ArcSignal } from "./arcs.js";
import { interestsOf } from "./interests.js";
import type { ArcState } from "@lumen/shared";
import { PeerVerdictZ, type PeerBeat } from "@lumen/shared";
import { applyPeerVerdict, type PeerEffect } from "./peer.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  normalizeTeachingAnalysis,
  TeachingAnalysisZ,
  type CadetCard,
  type CrowdReaction,
  type GameConfig,
  type ReactionState,
  type TeachingAnalysis,
} from "@lumen/shared";
import { and, eq, inArray } from "drizzle-orm";
import { callStructured } from "../agents/harness.js";
import { loadPrompt } from "../agents/prompts/load.js";
import {
  cadetTable,
  keyFactList,
  recentTranscript,
  type TranscriptLine,
} from "../agents/realtime/context.js";
import { runCrowdReactor, type ReactorResult } from "../agents/realtime/crowdReactor.js";
import { runCadetTurn, type CadetTurnResult } from "../agents/realtime/cadet.js";
import { guardUtterance, type GuardOutcome } from "../agents/realtime/leakGuard.js";
import { untaughtTerms, vocabulary } from "./leakTerms.js";
import type { DbHandle } from "../db/client.js";
import { newId } from "../db/ids.js";
import {
  cadets,
  chunks,
  classrooms,
  concepts,
  leakEvents,
  ledgerEntries,
  messages,
  modules,
  periods,
  sources,
  teacherErrors,
  turns,
} from "../db/schema.js";
import type { Embedder } from "../ingest/embed.js";
import type { ModelFactory } from "../models/factory.js";
import { withUsageContext } from "../usage/meter.js";
import { refreshConcepts } from "./conceptRefresh.js";
import { applyTurnToLedger, type LedgerChange, type Misconception } from "./ledger.js";
import { recall } from "./memory.js";

// One active Class Period (docs/03 §7): in-memory state, written through to
// SQLite every turn. Reactions stream out first; the Director's analysis is
// serialized and must commit before the next turn is built (ADR-002).

export type HandRaise = CrowdReaction["handRaises"][number] & { raisedAtTurn: number };

export interface SessionEvents {
  onReaction?: (cadetId: string, state: ReactionState) => void;
  onHands?: (queue: HandRaise[]) => void;
  onLedger?: (changes: LedgerChange[]) => void;
  onAnalysis?: (turnId: string, analysis: TeachingAnalysis, lowConfidence: boolean) => void;
  onConceptChange?: (conceptId: string, title: string) => void;
  onError?: (stage: "reactor" | "director" | "embedding" | "leakGuard", err: unknown) => void;
  /** The Leak Guard replaced a cadet's words (client shows a "rephrasing" shimmer). */
  onRewrite?: (messageId: string, cadetId: string, text: string) => void;
  /** V4-01: the crowd suggested a peer exchange and the server allowed it. */
  onPeerBeat?: (beat: PeerBeat) => void;
  /** V4-03: a student moved on in their growth arc ("Sora raised a hand for the first time!"). */
  onArc?: (cadetId: string, stage: number, moment: string) => void;
}

export interface SessionDeps {
  handle: DbHandle;
  factory: ModelFactory;
  game: GameConfig;
  embedder?: Embedder;
  now?: () => number;
  /** Director timeout before the one low-confidence retry (D3). */
  directorTimeoutMs?: number;
  /** Budget guard (docs/03 §8): degrade shrinks the crowd, pause stops teaching. */
  budget?: { budgetState(): string; assertCanCall(): void };
}

/** In budget-degrade mode only this many cadets react each turn (docs/03 §8). */
export const DEGRADED_CROWD = 6;

interface CadetState {
  id: string;
  name: string;
  archetype: CadetCard["archetype"];
  attention: number;
  skepticism: number;
  learningStyle: CadetCard["learningStyle"];
  lastState: ReactionState;
  lastSpokeTurn: number | null;
  /** V4-04 */
  interests: string[];
  /** V4-03 */
  arc: ArcState;
}

interface ConceptInfo {
  id: string;
  title: string;
  keyFacts: string[];
  misconceptions: string[];
}

export interface SpokenTurn extends CadetTurnResult {
  messageId: string;
  /** Resolves when the Leak Guard has passed, skipped or rewritten the words. */
  guard: Promise<GuardOutcome>;
}

export interface TurnHandle {
  turnId: string;
  /** Resolves when every cadet has reacted (reactions also stream via events). */
  reaction: Promise<ReactorResult | null>;
  /** Resolves when the analysis is applied to the ledger and saved. */
  committed: Promise<{
    analysis: TeachingAnalysis;
    lowConfidence: boolean;
    changes: LedgerChange[];
  }>;
}

const NEUTRAL: TeachingAnalysis = {
  conceptIds: [],
  teaching: { accuracy: 0.5, clarity: 0.5, coverage: [], errors: [] },
  ledgerDeltas: [],
};
const MAX_QUEUE = 5;
const HAND_TTL_TURNS = 2;
/** A cadet regains full priority this many turns after speaking. */
const FAIRNESS_TURNS = 4;

export class ClassSession {
  readonly periodId: string;
  private turnOrd = 0;
  private readonly transcript: TranscriptLine[] = [];
  private hands: HandRaise[] = [];
  private analysisChain: Promise<unknown> = Promise.resolve();
  private readonly background: Promise<unknown>[] = [];
  private conceptId: string;
  private offConceptStreak: { id: string; count: number } | null = null;
  private speaking: { cadetId: string; abort: AbortController; hand?: HandRaise } | null = null;
  /** Teaching time banked so far, plus the stretch running since `runningSince` (null = paused). */
  private activeMs: number;
  private runningSince: number | null;
  private closed = false;
  /** Overachievers who already used peek_ahead this period (once per period). */
  private readonly peeked = new Set<string>();
  /** Leak Guard vocabularies (docs/03 §6.5): what was taught, and what only the source says. */
  private taughtVocab = new Set<string>();
  private sourceVocab = new Set<string>();

  private constructor(
    private readonly deps: SessionDeps,
    readonly classroomId: string,
    private readonly cadetStates: CadetState[],
    private readonly curriculum: ConceptInfo[],
    conceptId: string,
    periodId: string,
    private readonly events: SessionEvents,
    private planned: number,
    /** True when this picked up an unfinished period (tab closed, server restarted). */
    readonly resumed: boolean,
    elapsedMs: number,
  ) {
    this.conceptId = conceptId;
    this.periodId = periodId;
    this.activeMs = elapsedMs;
    // A resumed period waits for the teacher to press Resume.
    this.runningSince = resumed ? null : this.now();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  static open(
    deps: SessionDeps,
    input: {
      classroomId: string;
      conceptId?: string;
      plannedMinutes?: number;
      /** Continue this classroom's unfinished period if it was active recently. */
      resume?: boolean;
      /** V3-01: a micro-lesson, one student at the front desk (picked if not given). */
      kind?: PeriodKind;
      cadetId?: string;
      /** V3-02: how I feel today. Low makes the class gentle and quiet. */
      energy?: Energy;
    },
    events: SessionEvents = {},
  ): ClassSession {
    const { db } = deps.handle;
    const room = db.select().from(classrooms).where(eq(classrooms.id, input.classroomId)).get();
    if (!room) throw new Error(`no classroom ${input.classroomId}`);
    if (room.status !== "active") throw new Error(`classroom is ${room.status}`);
    const curriculum = db
      .select({
        id: concepts.id,
        title: concepts.title,
        keyFacts: concepts.keyFactsJson,
        misconceptions: concepts.misconceptionsJson,
      })
      .from(concepts)
      .innerJoin(modules, eq(modules.id, concepts.moduleId))
      .where(eq(modules.schoolId, room.schoolId))
      .orderBy(modules.ord, concepts.ord)
      .all()
      .map((c) => ({
        id: c.id,
        title: c.title,
        keyFacts: JSON.parse(c.keyFacts) as string[],
        misconceptions: JSON.parse(c.misconceptions) as string[],
      }));
    if (!curriculum.length) throw new Error("this School has no curriculum yet");
    const conceptId = input.conceptId ?? room.currentConceptId ?? curriculum[0]!.id;
    if (!curriculum.some((c) => c.id === conceptId))
      throw new Error(`concept ${conceptId} is not in this School`);

    const roster = db
      .select()
      .from(cadets)
      .where(
        and(
          eq(cadets.classroomId, room.id),
          inArray(cadets.status, ["enrolled", "transferred_in"]),
        ),
      )
      .orderBy(cadets.seat)
      .all();
    if (!roster.length) throw new Error("no cadets enrolled");

    const open = settleOpenPeriods(deps, room.id, input.resume === true);
    // A resumed period keeps what it was; a new one takes what was asked for.
    const kind: PeriodKind = open?.kind ?? input.kind ?? "class";
    const flag = (deps.game.modes as Record<string, boolean | number>)[kind];
    if (!open && flag === false)
      throw new Error(`${modeInfo(kind).label} is switched off in game.yaml`);
    const energy = open ? open.energy : (input.energy ?? null);
    // One student at the centre: alone in a micro-lesson, in the hot seat in Socratic
    // and teach-back (V5), whoever knows the concept least unless I picked them.
    const focusId = ["micro", "socratic", "teach_back"].includes(kind)
      ? (open?.focusCadetId ?? input.cadetId ?? microStudent(deps, roster, conceptId))
      : null;
    const seated = kind === "micro" && focusId ? roster.filter((c) => c.id === focusId) : roster;
    if (!seated.length) throw new Error(`cadet ${focusId} is not in this class`);
    const states: CadetState[] = seated.map((c) => {
      const traits = JSON.parse(c.traitsJson) as { attention: number; skepticism: number };
      return {
        id: c.id,
        name: c.name,
        archetype: c.archetype as CadetCard["archetype"],
        attention: traits.attention,
        skepticism: traits.skepticism,
        learningStyle: c.learningStyle as CadetCard["learningStyle"],
        lastState: "attentive",
        lastSpokeTurn: null,
        interests: interestsOf(c.interestsJson),
        arc: parseArc(c.arcJson),
      };
    });

    const periodId = open?.id ?? newId("period");
    const plannedMinutes =
      open?.plannedMinutes ??
      (kind === "micro" ? deps.game.micro.minutes : (modeInfo(kind).minutes ?? undefined)) ??
      input.plannedMinutes ??
      deps.game.period.defaultMinutes;
    if (!open)
      db.insert(periods)
        .values({
          id: periodId,
          classroomId: room.id,
          startedAt: new Date().toISOString(),
          plannedMinutes,
          kind,
          energy,
          focusCadetId: focusId,
        })
        .run();
    db.update(classrooms)
      .set({ currentConceptId: conceptId })
      .where(eq(classrooms.id, room.id))
      .run();
    const session = new ClassSession(
      deps,
      room.id,
      states,
      curriculum,
      conceptId,
      periodId,
      events,
      plannedMinutes,
      !!open,
      open?.elapsedMs ?? 0,
    );
    session.kind = kind;
    session.hotSeat = focusId;
    session.glossary = (
      deps.handle.sqlite
        .prepare(
          "SELECT term FROM glossary_terms WHERE school_id = ? ORDER BY updated_at DESC LIMIT 40",
        )
        .all(room.schoolId) as Array<{ term: string }>
    ).map((r) => r.term);
    session.hotSeatStart = focusId
      ? ((
          deps.handle.sqlite
            .prepare(
              "SELECT comprehension c FROM ledger_entries WHERE cadet_id = ? AND concept_id = ?",
            )
            .get(focusId, conceptId) as { c: number } | undefined
        )?.c ?? 0)
      : 0;
    session.energy = energy;
    // Low energy (V3-02): a gentler crowd and shorter questions, whatever the class's usual difficulty.
    session.difficulty = energy === "low" ? "gentle" : (room.difficulty ?? "standard");
    if (open) session.restore(roster.map((c) => ({ id: c.id, name: c.name })));
    const earlier = deps.handle.sqlite
      .prepare(
        `SELECT m.text FROM messages m JOIN periods p ON p.id = m.period_id
         WHERE p.classroom_id = ? AND m.speaker = 'teacher'`,
      )
      .all(room.id) as { text: string }[];
    session.taughtVocab = vocabulary([
      ...earlier.map((m) => m.text),
      ...curriculum.map((c) => c.title),
      ...roster.flatMap((c) => [c.name, c.homeworld]),
    ]);
    const sourceText = deps.handle.db
      .select({ text: chunks.text })
      .from(chunks)
      .innerJoin(sources, eq(sources.id, chunks.sourceId))
      .where(eq(sources.schoolId, room.schoolId))
      .all()
      .map((r) => r.text);
    session.sourceVocab = vocabulary(sourceText);
    return session;
  }

  /** Teaching turns so far this period. */
  get turnCount(): number {
    return this.turnOrd;
  }

  get currentConcept(): ConceptInfo {
    return this.curriculum.find((c) => c.id === this.conceptId)!;
  }

  /** The School's concepts in teaching order. */
  get concepts(): ReadonlyArray<Pick<ConceptInfo, "id" | "title">> {
    return this.curriculum;
  }

  /** Everything said this period, oldest first. */
  get lines(): ReadonlyArray<TranscriptLine> {
    return this.transcript;
  }

  /** V5-11: a transfer student takes a seat mid-period. */
  admit(cadetId: string): void {
    if (this.cadetStates.some((c) => c.id === cadetId)) return;
    const c = this.deps.handle.db.select().from(cadets).where(eq(cadets.id, cadetId)).get();
    if (!c) return;
    const traits = JSON.parse(c.traitsJson) as { attention: number; skepticism: number };
    this.cadetStates.push({
      id: c.id,
      name: c.name,
      archetype: c.archetype as CadetCard["archetype"],
      attention: traits.attention,
      skepticism: traits.skepticism,
      learningStyle: c.learningStyle as CadetCard["learningStyle"],
      lastState: "confused",
      lastSpokeTurn: null,
      interests: interestsOf(c.interestsJson),
      arc: parseArc(c.arcJson),
    });
  }

  /** V5-03: true if a phrasing uses terms that neither I nor the raw statement used. */
  addsTerms(phrased: string, raw: string): boolean {
    const allowed = new Set([...this.taughtVocab, ...vocabulary([raw])]);
    return (
      untaughtTerms(
        phrased,
        allowed,
        this.sourceVocab,
        this.deps.game.leakGuard.untaughtTermThreshold,
      ).untaught.length > 0
    );
  }

  /** V5-03: record what the hot-seat student said as their teach-back. */
  recordTeachBack(cadetId: string, text: string): string {
    return this.recordCadetUtterance(cadetId, text, "answer", { teachBack: true });
  }

  /** V4-03/04: each student's interests and arc, for views and sticker rules. */
  get flavour(): ReadonlyArray<{
    id: string;
    archetype: string;
    interests: string[];
    arc: ArcState;
  }> {
    return this.cadetStates;
  }

  get handQueue(): HandRaise[] {
    return [...this.hands];
  }

  get roster(): ReadonlyArray<Pick<CadetState, "id" | "name" | "archetype" | "lastState">> {
    return this.cadetStates;
  }

  /** Teaching time so far; pauses and disconnects don't count. */
  elapsedMs(): number {
    return this.activeMs + (this.runningSince === null ? 0 : this.now() - this.runningSince);
  }

  periodMinute(): number {
    return this.elapsedMs() / 60_000;
  }

  get plannedMinutes(): number {
    return this.planned;
  }

  /** T-7: extend after the bell; saved so a resumed period keeps it. */
  extend(minutes: number): number {
    if (this.closed) throw new Error("period has ended");
    this.planned = Math.min(this.planned + minutes, this.deps.game.period.maxMinutes + 60);
    this.deps.handle.db
      .update(periods)
      .set({ plannedMinutes: this.planned })
      .where(eq(periods.id, this.periodId))
      .run();
    return this.planned;
  }

  /** T-10 Hyperfocus: sharper, more frequent questions (lighting is the client's). */
  hyperfocus = false;
  kind: PeriodKind = "class";
  /** V5: the student at the centre of a Socratic or teach-back period. */
  hotSeat: string | null = null;
  hotSeatStart = 0;
  /** V6-08: terms on the glossary wall, for the crowd. */
  glossary: string[] = [];
  private peerCount = 0;
  private lastPeerTurn = -Infinity;
  /**
   * V4-01 (VD9): may the crowd suggest a peer exchange now? Off in quiet
   * periods, capped per period, spaced out, and never over someone speaking.
   */
  private peerOk(ord: number): boolean {
    const p = this.deps.game.peerTalk;
    return (
      p.enabled &&
      !this.quiet &&
      this.cadetStates.length >= 2 &&
      this.peerCount < p.maxPerPeriod &&
      ord >= p.fromTurn &&
      ord - this.lastPeerTurn >= p.minTurnsBetween
    );
  }
  energy: Energy | null = null;
  /** V3-01/02: no surprise events in a micro-lesson or on a low-energy day. */
  get quiet(): boolean {
    // Every mode but the lecture is its own exercise: no surprises, no peer talk (V5).
    return this.kind !== "class" || this.energy === "low";
  }
  /** R-6: the class's difficulty also sets how sharp its questions are. */
  difficulty: "gentle" | "standard" | "ruthless" = "standard";

  /** T-9: the chalkboard block for this period ("" = clear). Cadets see it in the transcript. */
  get board(): string {
    const row = this.deps.handle.sqlite
      .prepare(
        "SELECT text FROM messages WHERE period_id = ? AND kind = 'board' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(this.periodId) as { text: string } | undefined;
    return row?.text ?? "";
  }

  setBoard(text: string): string {
    if (this.closed) throw new Error("period has ended");
    const t = text.trim();
    this.saveMessage("teacher", "board", t);
    if (t) this.transcript.push({ speaker: "Teacher", text: `(writes on the board) ${t}` });
    return t;
  }

  get paused(): boolean {
    return this.runningSince === null;
  }

  /** Esc at the lectern: the clock stops and the class waits; a speaking cadet stops. */
  pause(): void {
    if (this.closed || this.paused) return;
    this.interruptSpeaker();
    this.activeMs = this.elapsedMs();
    this.runningSince = null;
    this.saveElapsed();
  }

  resume(): void {
    if (this.closed || !this.paused) return;
    this.runningSince = this.now();
  }

  private assertTeaching() {
    if (this.closed) throw new Error("period has ended");
    if (this.paused) throw new Error("class is paused; resume it first");
  }

  private saveElapsed() {
    this.deps.handle.db
      .update(periods)
      .set({ elapsedMs: Math.round(this.elapsedMs()) })
      .where(eq(periods.id, this.periodId))
      .run();
  }

  /** Rebuilds what a resumed period had in memory: the dialogue so far and the turn count. */
  private restore(roster: Array<{ id: string; name: string }>) {
    const { sqlite } = this.deps.handle;
    const rows = sqlite
      .prepare(
        `SELECT speaker, kind, text FROM messages WHERE period_id = ?
         AND kind IN ('lecture','answer','question','objection','claim','board') ORDER BY created_at, rowid`,
      )
      .all(this.periodId) as Array<{ speaker: string; kind: string; text: string }>;
    for (const r of rows) {
      if (r.kind === "board" && !r.text) continue;
      this.transcript.push({
        speaker:
          r.speaker === "teacher"
            ? "Teacher"
            : (roster.find((c) => c.id === r.speaker)?.name ?? r.speaker),
        text: r.kind === "board" ? `(writes on the board) ${r.text}` : r.text,
      });
    }
    const ord = sqlite
      .prepare("SELECT max(ord) AS n FROM turns WHERE period_id = ?")
      .get(this.periodId) as { n: number | null };
    this.turnOrd = ord.n ?? 0;
  }

  /** The teacher said something (T-1..T-6). */
  teach(text: string, opts: { conceptId?: string; replyToCadetId?: string } = {}): TurnHandle {
    this.assertTeaching();
    // Refuse up front when paused, so nothing is half-saved (BudgetPausedError).
    this.deps.budget?.assertCanCall();
    this.interruptSpeaker();
    if (opts.conceptId) this.setConcept(opts.conceptId);
    const turnId = newId("turn");
    const ord = ++this.turnOrd;
    for (const w of vocabulary([text])) this.taughtVocab.add(w);
    const messageId = this.saveMessage(
      "teacher",
      opts.replyToCadetId ? "answer" : "lecture",
      text,
      opts.replyToCadetId,
    );
    // V4-05: what the last turn recalled, taken now (this turn's own recall may land first).
    const pastClaims = this.pastClaims;
    this.embedTeacherMessage(messageId, text);
    this.arcSignal({ kind: "teach", text, replyToCadetId: opts.replyToCadetId });

    // Snapshot the transcript now: "recent class" must not include this message,
    // which the prompts present separately as what the Headmaster just said.
    const before = [...this.transcript];
    this.transcript.push({ speaker: "Teacher", text });
    // The reactor starts at once on the ledger as it stands (at most one turn
    // stale): a gut reaction doesn't need the last analysis, and waiting for it
    // cost ~1s of first-reaction latency (D13). The Director still waits, so
    // ledger writes stay serialized (ADR-002).
    const now = Promise.resolve({ cards: this.cards(), transcript: before });
    const ready = this.analysisChain.catch(() => undefined);
    const shared = ready.then(() => ({ cards: this.cards(), transcript: before }));

    const reaction = withUsageContext({ periodId: this.periodId }, () =>
      now.then(({ cards, transcript }) =>
        runCrowdReactor(
          this.deps.factory,
          {
            cards: this.crowdFor(cards, ord),
            conceptTitle: this.currentConcept.title,
            transcript,
            teacherMessage: text,
            maxHands: this.deps.game.hands.maxPerTurn,
            hyperfocus: this.hyperfocus,
            difficulty: this.difficulty,
            peerOk: this.peerOk(ord),
            pastClaims,
            glossary: this.glossary,
          },
          { onReaction: (id, state) => this.events.onReaction?.(id, state) },
        )
          .then((r) => {
            for (const x of r.reaction.reactions) {
              const s = this.cadetStates.find((c) => c.id === x.cadetId);
              if (s) s.lastState = x.state;
            }
            this.mergeHands(r.reaction.handRaises, ord);
            const beat = r.reaction.peerBeat;
            if (beat && this.peerOk(ord) && this.turnOrd === ord && !this.speaking) {
              this.peerCount++;
              this.lastPeerTurn = ord;
              this.events.onPeerBeat?.(beat);
            }
            return r;
          })
          .catch((err: unknown) => {
            this.events.onError?.("reactor", err);
            return null;
          }),
      ),
    );

    const committed = withUsageContext({ periodId: this.periodId }, () =>
      shared.then(({ cards, transcript }) =>
        this.analyse(turnId, ord, messageId, text, cards, transcript, opts),
      ),
    );
    this.analysisChain = committed;
    return { turnId, reaction, committed };
  }

  /** The teacher called on a cadet: they speak until the next teach() (M1-10 plugs in the voice). */
  call(cadetId: string): { cadetId: string; signal: AbortSignal; hand?: HandRaise } {
    this.assertTeaching();
    const hand = this.hands.find((h) => h.cadetId === cadetId);
    this.hands = this.hands.filter((h) => h.cadetId !== cadetId);
    this.events.onHands?.(this.handQueue);
    const s = this.cadetStates.find((c) => c.id === cadetId);
    if (!s) throw new Error(`cadet ${cadetId} is not in this class`);
    s.lastSpokeTurn = this.turnOrd;
    this.interruptSpeaker();
    const abort = new AbortController();
    this.speaking = { cadetId, abort, hand };
    this.arcSignal({ kind: "called", cadetId });
    return { cadetId, signal: abort.signal, hand };
  }

  /** Records what a called cadet said (transcript + messages table). */
  recordCadetUtterance(
    cadetId: string,
    text: string,
    kind: "question" | "answer" | "objection" | "claim" | "peer" = "question",
    meta?: unknown,
    /** V4-01: peer lines read "(to Sora) …" in the class transcript. */
    toName?: string,
  ): string {
    if (this.speaking?.cadetId === cadetId) this.speaking = null;
    const name = this.cadetStates.find((c) => c.id === cadetId)?.name ?? cadetId;
    this.transcript.push({ speaker: name, text: toName ? `(to ${toName}) ${text}` : text });
    return this.saveMessage(cadetId, kind, text, undefined, meta);
  }

  /**
   * Calls on a cadet and streams what they say (T-3/T-4). A teach() while they
   * speak aborts them and their hand goes back up. Returns null if interrupted.
   */
  async speak(
    cadetId: string,
    opts: {
      onDelta?: (text: string) => void;
      /** V4-01: talk to a classmate (explain, or reply to what they said). */
      peer?: { role: "explain" | "reply"; toId: string; preview?: string; said?: string };
      /** V5-02: answer the teacher's Socratic question. */
      answer?: string;
      /** V5-11: one side of a class debate. */
      debate?: { stance: "for" | "against"; claim: string; heard?: string };
    } = {},
  ): Promise<SpokenTurn | null> {
    const to = opts.peer && this.cadetStates.find((c) => c.id === opts.peer!.toId);
    if (opts.peer && (!to || this.speaking)) return null;
    const { signal, hand } = opts.peer ? this.callPeer(cadetId) : this.call(cadetId);
    const { handle, factory, embedder, game } = this.deps;
    const row = handle.db.select().from(cadets).where(eq(cadets.id, cadetId)).get()!;
    const ledger = handle.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.cadetId, cadetId), eq(ledgerEntries.conceptId, this.conceptId)))
      .get();
    const idx = this.curriculum.findIndex((c) => c.id === this.conceptId);
    const canPeek = row.archetype === "overachiever" && !this.peeked.has(cadetId);
    try {
      const result = await withUsageContext({ periodId: this.periodId }, () =>
        runCadetTurn(
          { factory, handle, embedder },
          {
            persona: {
              id: row.id,
              name: row.name,
              homeworld: row.homeworld,
              archetype: row.archetype as never,
              quirk: row.quirk,
              voiceNotes: row.voiceNotes,
              notesMd: row.notesMd,
              interests: interestsOf(row.interestsJson),
              arcLine: arcPrompt(
                row.archetype as CadetCard["archetype"],
                this.cadetStates.find((c) => c.id === cadetId)?.arc ?? parseArc(row.arcJson),
              ),
            },
            classroomId: this.classroomId,
            concept: {
              id: this.conceptId,
              title: this.currentConcept.title,
              nextId: this.curriculum[idx + 1]?.id,
            },
            comprehension: ledger
              ? recall(
                  ledger.comprehension,
                  ledger.lastTaughtAt,
                  ledger.stabilityDays,
                  new Date(),
                  this.deps.game.memory,
                )
              : 0,
            misconceptions: ledger
              ? (JSON.parse(ledger.misconceptionsJson) as Misconception[]).map((m) => m.text)
              : [],
            transcript: [...this.transcript],
            intent: opts.peer ? "talk to a classmate" : (hand?.intent ?? "clarify"),
            preview: opts.peer?.preview ?? hand?.preview ?? "(the teacher called on you)",
            ...(to
              ? { peer: { role: opts.peer!.role, name: to.name, said: opts.peer!.said } }
              : {}),
            ...(opts.answer ? { answering: opts.answer } : {}),
            ...(opts.debate ? { debate: opts.debate } : {}),
            canPeek: canPeek && !opts.peer,
            pastClaims: this.pastClaims,
            hyperfocus: this.hyperfocus,
            difficulty: this.difficulty,
            maxWords: game.cadet.maxWords,
          },
          { signal, onDelta: opts.onDelta },
        ),
      );
      if (signal.aborted) return null;
      if (result.peeked) this.peeked.add(cadetId);
      const kind = opts.peer
        ? "peer"
        : opts.answer
          ? "answer"
          : result.utterance.kind === "objection" ||
              result.utterance.kind === "claim" ||
              result.utterance.kind === "answer"
            ? result.utterance.kind
            : "question";
      const messageId = this.recordCadetUtterance(
        cadetId,
        result.utterance.text,
        kind,
        {
          mood: result.utterance.mood,
          confidence: result.utterance.confidence,
          tools: result.usedTools,
          ...(to ? { to: to.id } : {}),
        },
        to?.name.split(" ")[0],
      );
      const guard = this.guard(messageId, row, result);
      this.background.push(guard);
      return { ...result, messageId, guard };
    } catch (err) {
      if (signal.aborted) return null;
      throw err;
    }
  }

  /**
   * V4-05: what I said in earlier classes about the same idea, found with the
   * vector of what I just said. It's my words, never the source, so knowledge
   * gating is unchanged. The next reactor and any student I call get it.
   */
  private pastClaims: string[] = [];
  private recallPastClaims(v: Float32Array | number[]): string[] {
    const cfg = this.deps.game.pastClaims;
    if (!cfg.enabled) return [];
    const { sqlite } = this.deps.handle;
    const vec = v instanceof Float32Array ? v : new Float32Array(v);
    const near = sqlite
      .prepare(
        "SELECT message_id FROM message_vec WHERE embedding MATCH ? AND k = 40 ORDER BY distance",
      )
      .all(vec) as Array<{ message_id: string }>;
    if (!near.length) return [];
    const ids = near.map((n) => n.message_id);
    const rows = sqlite
      .prepare(
        `SELECT m.id, m.text, m.created_at AS at, vec_distance_cosine(v.embedding, ?) AS d
         FROM messages m JOIN periods p ON p.id = m.period_id JOIN message_vec v ON v.message_id = m.id
         WHERE p.classroom_id = ? AND p.id != ? AND m.speaker = 'teacher'
           AND m.id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(vec, this.classroomId, this.periodId, ...ids) as Array<{
      id: string;
      text: string;
      at: string;
      d: number;
    }>;
    const now = this.now();
    return rows
      .filter((r) => 1 - r.d >= cfg.minSimilarity)
      .sort((a, b) => a.d - b.d)
      .slice(0, cfg.max)
      .map((r) => {
        const days = Math.max(0, Math.round((now - Date.parse(r.at)) / 86_400_000));
        const when = days === 0 ? "earlier today" : days === 1 ? "yesterday" : `${days} days ago`;
        return `${when}: "${r.text.length > 220 ? `${r.text.slice(0, 217)}…` : r.text}"`;
      });
  }

  /** V4-03 (VD10): feeds one signal to every student's arc; saves and announces any move. */
  private arcSignal(signal: ArcSignal) {
    for (const s of this.cadetStates) {
      const r = arcStep(s, s.arc, signal, this.deps.game.arcs);
      if (r.state === s.arc) continue;
      s.arc = r.state;
      this.deps.handle.sqlite
        .prepare("UPDATE cadets SET arc_json = ? WHERE id = ?")
        .run(JSON.stringify(s.arc), s.id);
      if (r.advanced) this.events.onArc?.(s.id, s.arc.stage, arcMoment(s.archetype, s.arc, s.name));
    }
  }

  /** V4-01: a student turns to a classmate. Nothing changes in the hand queue. */
  private callPeer(cadetId: string): { cadetId: string; signal: AbortSignal; hand?: HandRaise } {
    this.assertTeaching();
    const s = this.cadetStates.find((c) => c.id === cadetId);
    if (!s) throw new Error(`cadet ${cadetId} is not in this class`);
    s.lastSpokeTurn = this.turnOrd;
    const abort = new AbortController();
    this.speaking = { cadetId, abort };
    return { cadetId, signal: abort.signal };
  }

  /**
   * V4-02: grade what a student told a classmate against the key facts, and
   * let it move the listener (server rules in game/peer.ts). Never shown to
   * the client: judging it is my job.
   */
  async gradePeer(listenerId: string, said: string): Promise<PeerEffect | null> {
    const c = this.currentConcept;
    try {
      const res = await withUsageContext({ periodId: this.periodId }, () =>
        callStructured(this.deps.factory, "peerGrader", {
          schema: PeerVerdictZ,
          name: "peer_verdict",
          messages: [
            new SystemMessage(
              loadPrompt("peerGrader", {
                conceptTitle: c.title,
                keyFacts: c.keyFacts.map((f) => `- ${f}`).join("\n"),
              }),
            ),
            new HumanMessage(`What the student said:\n"${said}"`),
          ],
        }),
      );
      return applyPeerVerdict(this.deps.handle, this.deps.game, {
        listenerId,
        conceptId: c.id,
        verdict: res.data,
      });
    } catch (err) {
      this.events.onError?.("director", err);
      return null;
    }
  }

  /** Runs the Leak Guard on what a cadet just said, rewriting it in place if it leaked. */
  private async guard(
    messageId: string,
    row: { id: string; name: string; voiceNotes: string },
    result: CadetTurnResult,
  ): Promise<GuardOutcome> {
    const { game, handle, factory } = this.deps;
    const text = result.utterance.text;
    const skipped = (): GuardOutcome => ({
      action: "skipped",
      text,
      flaggedTerms: [],
      leakedTerms: [],
      forced: false,
    });
    // A peek is the one sanctioned way to know more (framed as "I read ahead…").
    if (!game.leakGuard.enabled || result.peeked) return skipped();
    const terms = untaughtTerms(
      text,
      this.taughtVocab,
      this.sourceVocab,
      game.leakGuard.untaughtTermThreshold,
    );
    let outcome: GuardOutcome;
    try {
      outcome = await withUsageContext({ periodId: this.periodId }, () =>
        guardUtterance(factory, {
          utteranceId: messageId,
          utterance: text,
          // My earlier-class claims count as taught too (V4-05): students may quote them.
          taughtLines: [
            ...this.pastClaims,
            ...this.transcript.filter((l) => l.speaker === "Teacher").map((l) => l.text),
          ],
          flaggedTerms: terms.untaught,
          forced: terms.forceGuard,
          sampleRate: this.deps.factory.config.agents.leakGuard.sampleRate ?? 0.5,
          persona: { name: row.name, voiceNotes: row.voiceNotes },
        }),
      );
    } catch (err) {
      this.events.onError?.("leakGuard", err);
      return skipped();
    }
    if (outcome.action !== "skipped") {
      handle.db
        .insert(leakEvents)
        .values({
          ts: new Date().toISOString(),
          utteranceId: messageId,
          cadetId: row.id,
          flaggedTermsJson: JSON.stringify({
            heuristic: outcome.flaggedTerms,
            leaked: outcome.leakedTerms,
            forced: outcome.forced,
            reason: outcome.reason,
          }),
          action:
            outcome.action === "rewrite"
              ? "rewrite"
              : outcome.action === "rewrite_failed"
                ? "rewrite_failed"
                : "pass",
        })
        .run();
    }
    if (outcome.action === "rewrite") {
      handle.db
        .update(messages)
        .set({ text: outcome.text })
        .where(eq(messages.id, messageId))
        .run();
      const line = [...this.transcript]
        .reverse()
        .find((l) => l.speaker === row.name && l.text === text);
      if (line) line.text = outcome.text;
      this.events.onRewrite?.(messageId, row.id, outcome.text);
    }
    return outcome;
  }

  /** Ends the period for good (End class, bell). */
  async close(): Promise<void> {
    if (await this.settle()) this.endPeriod();
  }

  /**
   * The connection went away mid-period: finish pending writes and bank the
   * time, but leave the period open so reopening the classroom continues it.
   */
  async suspend(): Promise<void> {
    await this.settle();
  }

  private endPeriod() {
    this.deps.handle.db
      .update(periods)
      .set({ endedAt: new Date().toISOString() })
      .where(eq(periods.id, this.periodId))
      .run();
  }

  /** Stops the session once; false if it already was. */
  private async settle(): Promise<boolean> {
    if (this.closed) return false;
    this.activeMs = this.elapsedMs();
    this.runningSince = null;
    this.closed = true;
    this.interruptSpeaker();
    await this.analysisChain.catch(() => undefined);
    await Promise.allSettled(this.background);
    this.saveElapsed();
    return true;
  }

  // --- internals -------------------------------------------------------------

  private interruptSpeaker() {
    if (!this.speaking) return;
    this.speaking.abort.abort();
    // An interrupted cadet keeps their hand up (docs/03 §7).
    if (this.speaking.hand)
      this.hands = [
        this.speaking.hand,
        ...this.hands.filter((h) => h.cadetId !== this.speaking!.cadetId),
      ].slice(0, MAX_QUEUE);
    this.speaking = null;
    this.events.onHands?.(this.handQueue);
  }

  private mergeHands(raised: CrowdReaction["handRaises"], ord: number) {
    const fresh = raised.map((h) => ({ ...h, raisedAtTurn: ord }));
    const kept = this.hands.filter(
      (h) => ord - h.raisedAtTurn < HAND_TTL_TURNS && !fresh.some((f) => f.cadetId === h.cadetId),
    );
    this.hands = [...fresh, ...kept]
      .sort((a, b) => this.handPriority(b) - this.handPriority(a))
      .slice(0, MAX_QUEUE);
    this.events.onHands?.(this.handQueue);
  }

  /**
   * Urgency, discounted for cadets who spoke recently, so one eager cadet
   * doesn't own the queue (the reactor is told the same, but bids high anyway).
   */
  private handPriority(h: HandRaise): number {
    const last = this.cadetStates.find((c) => c.id === h.cadetId)?.lastSpokeTurn;
    if (last === null || last === undefined) return h.urgency;
    const since = this.turnOrd - last;
    return h.urgency * Math.min(1, (since + 1) / FAIRNESS_TURNS);
  }

  /** Switches the current concept (T-6 explicit tag, CLI /concept). */
  setConcept(conceptId: string) {
    const c = this.curriculum.find((x) => x.id === conceptId);
    if (!c || conceptId === this.conceptId) return;
    this.conceptId = conceptId;
    this.offConceptStreak = null;
    this.deps.handle.db
      .update(classrooms)
      .set({ currentConceptId: conceptId })
      .where(eq(classrooms.id, this.classroomId))
      .run();
    this.events.onConceptChange?.(c.id, c.title);
  }

  /**
   * The cadets who react this turn: everyone normally; in degrade mode a
   * rotating window of DEGRADED_CROWD (the rest keep their last state).
   */
  private crowdFor(cards: CadetCard[], ord: number): CadetCard[] {
    if (this.deps.budget?.budgetState() !== "degrade" || cards.length <= DEGRADED_CROWD)
      return cards;
    const start = ((ord - 1) * DEGRADED_CROWD) % cards.length;
    return Array.from({ length: DEGRADED_CROWD }, (_, i) => cards[(start + i) % cards.length]!);
  }

  private cards(): CadetCard[] {
    const rows = this.deps.handle.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          inArray(
            ledgerEntries.cadetId,
            this.cadetStates.map((c) => c.id),
          ),
          eq(ledgerEntries.conceptId, this.conceptId),
        ),
      )
      .all();
    return this.cadetStates.map((s) => {
      const row = rows.find((r) => r.cadetId === s.id);
      const held = row ? (JSON.parse(row.misconceptionsJson) as Misconception[]) : [];
      return {
        id: s.id,
        name: s.name,
        archetype: s.archetype,
        attention: s.attention,
        skepticism: s.skepticism,
        learningStyle: s.learningStyle,
        // What they recall now (V2 forgetting): a faded concept shows in how they react.
        comprehension: row
          ? recall(
              row.comprehension,
              row.lastTaughtAt,
              row.stabilityDays,
              new Date(),
              this.deps.game.memory,
            )
          : 0,
        misconceptions: held.slice(-2).map((m) => m.text),
        interests: s.interests,
        arc: arcPrompt(s.archetype, s.arc),
        lastState: s.lastState,
        spokeTurnsAgo: s.lastSpokeTurn === null ? null : this.turnOrd - s.lastSpokeTurn,
      };
    });
  }

  private directorMessages(cards: CadetCard[], transcript: TranscriptLine[], text: string) {
    const c = this.currentConcept;
    const system = loadPrompt("classDirector", {
      conceptId: c.id,
      conceptTitle: c.title,
      keyFacts: keyFactList(c.keyFacts),
      knownMisconceptions: c.misconceptions.length
        ? c.misconceptions.map((m) => `- ${m}`).join("\n")
        : "(none listed)",
      otherConcepts: this.curriculum
        .filter((x) => x.id !== c.id)
        .map((x) => `- ${x.id}: ${x.title}`)
        .join("\n"),
      cadetTable: cadetTable(cards, { withSpoke: false }),
      socratic: this.kind === "socratic",
    });
    return [
      new SystemMessage(system),
      new HumanMessage(
        `Recent class:\n${recentTranscript(transcript)}\n\nThe teacher just said:\n"${text}"`,
      ),
    ];
  }

  private async analyse(
    turnId: string,
    ord: number,
    messageId: string,
    text: string,
    cards: CadetCard[],
    transcript: TranscriptLine[],
    opts: { conceptId?: string },
  ) {
    const msgs = this.directorMessages(cards, transcript, text);
    const timeout = this.deps.directorTimeoutMs ?? 8_000;
    let analysis: TeachingAnalysis;
    let lowConfidence = false;
    try {
      analysis = (
        await callStructured(this.deps.factory, "classDirector", {
          schema: TeachingAnalysisZ,
          name: "teaching_analysis",
          messages: msgs,
          signal: AbortSignal.timeout(timeout),
        })
      ).data;
    } catch (first) {
      // D3: one more try with more time; its deltas count at reduced weight.
      lowConfidence = true;
      try {
        analysis = (
          await callStructured(this.deps.factory, "classDirector", {
            schema: TeachingAnalysisZ,
            name: "teaching_analysis",
            messages: msgs,
            signal: AbortSignal.timeout(timeout * 2),
          })
        ).data;
      } catch (second) {
        this.events.onError?.(
          "director",
          new AggregateError([first, second], "Director failed twice; neutral turn"),
        );
        analysis = NEUTRAL;
      }
    }
    analysis = normalizeTeachingAnalysis(analysis);
    const known = new Set(this.curriculum.map((c) => c.id));
    analysis.conceptIds = opts.conceptId
      ? [opts.conceptId]
      : analysis.conceptIds.filter((id) => known.has(id));
    const cadetIds = new Set(this.cadetStates.map((c) => c.id));
    analysis.ledgerDeltas = analysis.ledgerDeltas.filter(
      (d) => cadetIds.has(d.cadetId) && analysis.conceptIds.includes(d.conceptId),
    );

    const { handle, game } = this.deps;
    const changes = applyTurnToLedger(handle, game, {
      turnId,
      message: text,
      periodMinute: this.periodMinute(),
      analysis,
      cadets: this.cadetStates,
      lowConfidence,
    });
    const reactionSnapshot = {
      reactions: this.cadetStates.map((c) => ({ cadetId: c.id, state: c.lastState })),
      handRaises: this.hands,
    };
    handle.sqlite.transaction(() => {
      handle.db
        .insert(turns)
        .values({
          id: turnId,
          periodId: this.periodId,
          ord,
          teacherMessageId: messageId,
          analysisJson: JSON.stringify(analysis),
          reactionsJson: JSON.stringify(reactionSnapshot),
          lowConfidence,
          createdAt: new Date().toISOString(),
        })
        .run();
      for (const e of analysis.teaching.errors) {
        handle.db
          .insert(teacherErrors)
          .values({
            id: newId("teacherError"),
            turnId,
            conceptId: analysis.conceptIds[0] ?? this.conceptId,
            claim: e.claim,
            correction: e.correction,
            citation: e.citation,
          })
          .run();
      }
      handle.db
        .update(messages)
        .set({ conceptId: analysis.conceptIds[0] ?? null })
        .where(eq(messages.id, messageId))
        .run();
    })();
    refreshConcepts(handle, analysis.conceptIds, game.status);
    this.trackInferredConcept(analysis.conceptIds[0], opts.conceptId);

    this.events.onAnalysis?.(turnId, analysis, lowConfidence);
    this.events.onLedger?.(changes);
    for (const ch of changes)
      if (ch.resolved.length) this.arcSignal({ kind: "resolved", cadetId: ch.cadetId });
    return { analysis, lowConfidence, changes };
  }

  /** T-6: if the Director tags another concept two turns running, the class has moved on. */
  private trackInferredConcept(tagged: string | undefined, explicit: string | undefined) {
    if (explicit || !tagged || tagged === this.conceptId) {
      this.offConceptStreak = null;
      return;
    }
    this.offConceptStreak =
      this.offConceptStreak?.id === tagged
        ? { id: tagged, count: this.offConceptStreak.count + 1 }
        : { id: tagged, count: 1 };
    if (this.offConceptStreak.count >= 2) this.setConcept(tagged);
  }

  private saveMessage(
    speaker: string,
    kind: "lecture" | "answer" | "question" | "objection" | "claim" | "board" | "peer",
    text: string,
    replyToId?: string,
    meta?: unknown,
  ): string {
    const id = newId("message");
    this.deps.handle.db
      .insert(messages)
      .values({
        id,
        periodId: this.periodId,
        speaker,
        kind,
        text,
        conceptId: this.conceptId,
        replyToId: replyToId ?? null,
        metaJson: meta === undefined ? null : JSON.stringify(meta),
        createdAt: new Date().toISOString(),
      })
      .run();
    return id;
  }

  /** Teacher messages feed the cadets' recall_lesson tool (message_vec); never blocks the turn. */
  private embedTeacherMessage(messageId: string, text: string) {
    const embedder = this.deps.embedder;
    if (!embedder) return;
    const job = withUsageContext({ periodId: this.periodId }, () =>
      embedder
        .embed([text])
        .then(([v]) => {
          if (!v) return;
          this.deps.handle.sqlite
            .prepare("INSERT INTO message_vec (message_id, embedding) VALUES (?, ?)")
            .run(messageId, v);
          this.pastClaims = this.recallPastClaims(v);
        })
        .catch((err: unknown) => this.events.onError?.("embedding", err)),
    );
    this.background.push(job);
  }
}

/**
 * Before a period opens: the classroom's most recent unfinished period, if it
 * may be resumed (asked for, and active within game.period.resumeWithinHours).
 * Every other unfinished period is closed at its last activity.
 */
function settleOpenPeriods(
  deps: SessionDeps,
  classroomId: string,
  resume: boolean,
): {
  id: string;
  plannedMinutes: number;
  elapsedMs: number;
  kind: PeriodKind;
  energy: Energy | null;
  focusCadetId: string | null;
} | null {
  const { sqlite } = deps.handle;
  const open = sqlite
    .prepare(
      `SELECT p.id, p.planned_minutes AS plannedMinutes, p.elapsed_ms AS elapsedMs,
         p.kind, p.energy, p.focus_cadet_id AS focusCadetId,
         coalesce((SELECT max(m.created_at) FROM messages m WHERE m.period_id = p.id), p.started_at) AS lastActive
       FROM periods p WHERE p.classroom_id = ? AND p.ended_at IS NULL ORDER BY p.started_at DESC`,
    )
    .all(classroomId) as Array<{
    id: string;
    plannedMinutes: number;
    elapsedMs: number;
    kind: PeriodKind;
    energy: Energy | null;
    focusCadetId: string | null;
    lastActive: string;
  }>;
  const windowMs = deps.game.period.resumeWithinHours * 3_600_000;
  const now = (deps.now ?? Date.now)();
  const [latest] = open;
  const keep =
    resume && latest && now - Date.parse(latest.lastActive) <= windowMs ? latest : undefined;
  const end = sqlite.prepare("UPDATE periods SET ended_at = ? WHERE id = ?");
  for (const p of open) if (p !== keep) end.run(p.lastActive, p.id);
  if (!keep) return null;
  return {
    id: keep.id,
    plannedMinutes: keep.plannedMinutes,
    elapsedMs: keep.elapsedMs,
    kind: keep.kind,
    energy: keep.energy,
    focusCadetId: keep.focusCadetId,
  };
}

export type { PeriodKind };
export type Energy = "low" | "ok" | "high";

/** V3-01: the student who understands this concept least comes to the front (ties: by seat). */
function microStudent(deps: SessionDeps, roster: Array<{ id: string }>, conceptId: string): string {
  const known = new Map(
    (
      deps.handle.sqlite
        .prepare(
          "SELECT cadet_id AS id, comprehension AS c FROM ledger_entries WHERE concept_id = ?",
        )
        .all(conceptId) as Array<{ id: string; c: number }>
    ).map((r) => [r.id, r.c]),
  );
  return roster.reduce((a, c) => ((known.get(c.id) ?? 0) < (known.get(a.id) ?? 0) ? c : a)).id;
}
