import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  AnalogySetZ,
  ModeJudgementZ,
  SubstituteLessonZ,
  type SubstituteLesson,
  type AnalogySet,
  type GameConfig,
  type ServerMessage,
} from "@lumen/shared";
import { callStructured } from "../agents/harness.js";
import { loadPrompt } from "../agents/prompts/load.js";
import { keyFactList } from "../agents/realtime/context.js";
import type { DbHandle } from "../db/client.js";
import type { ClassSession } from "../game/ClassSession.js";
import type { ModeResult } from "../game/modes.js";
import { awardXp, type XpScope } from "../game/xp.js";
import type { ModelFactory } from "../models/factory.js";
import { withUsageContext } from "../usage/meter.js";

// Mode runners (V5-04, V5-05, V5-08): the modes whose flow is cards and
// rounds rather than free teaching. Each keeps its own state and reports a
// ModeResult at the bell. The connection forwards messages in and out.

export interface ModeHost {
  send(m: ServerMessage): void;
  /** Says a student line in class (speech panel and voice). */
  say(cadetId: string, text: string, mood?: "curious" | "proud" | "confused"): void;
  handle: DbHandle;
  factory: ModelFactory;
  game: GameConfig;
  scope: XpScope | null;
}

const usage = <T>(session: ClassSession, fn: () => Promise<T>) =>
  withUsageContext({ periodId: session.periodId }, fn);

// --- V5-04 Analogy lab ---------------------------------------------------------

export class AnalogyLab {
  private cards: AnalogySet["analogies"] = [];
  private judged = new Map<number, { right: boolean; reasonScore: number }>();

  constructor(
    private readonly host: ModeHost,
    private readonly session: ClassSession,
  ) {}

  /** The Connector (or whoever's there) offers three analogies. */
  async start() {
    const s = this.session;
    const who = s.flavour.find((f) => f.archetype === "connector") ?? s.flavour[0];
    if (!who) return;
    const c = s.currentConcept;
    const res = await usage(s, () =>
      callStructured(this.host.factory, "analogyMaker", {
        schema: AnalogySetZ,
        name: "analogies",
        messages: [
          new SystemMessage(
            loadPrompt("analogyMaker", {
              conceptTitle: c.title,
              keyFacts: keyFactList(c.keyFacts),
              interests: who.interests.join(", "),
            }),
          ),
          new HumanMessage("Write the three analogies."),
        ],
      }),
    );
    this.cards = res.data.analogies;
    this.host.say(
      who.id,
      `Ooh, I've got ${this.cards.length} ways to picture "${c.title}". Tell me which ones work, and where they break.`,
      "proud",
    );
    this.host.send({
      type: "analogy.cards",
      payload: { cadetId: who.id, cards: this.cards.map((a) => a.text) },
    });
  }

  async judge(i: number, verdict: "good" | "misleading", reason: string) {
    const card = this.cards[i];
    if (!card || this.judged.has(i)) return;
    const right = (verdict === "good") === card.sound;
    this.judged.set(i, { right, reasonScore: 0 });
    const c = this.session.currentConcept;
    let reasonScore = 0;
    let feedback = card.breaks;
    if (reason.trim())
      try {
        const res = await usage(this.session, () =>
          callStructured(this.host.factory, "modeJudge", {
            schema: ModeJudgementZ,
            name: "analogy_reason",
            messages: [
              new SystemMessage(
                loadPrompt("analogyJudge", {
                  conceptTitle: c.title,
                  keyFacts: keyFactList(c.keyFacts),
                  analogy: card.text,
                  sound: card.sound,
                  breaks: card.breaks,
                  verdict: verdict === "good" ? "a good analogy" : "misleading",
                  reason,
                }),
              ),
              new HumanMessage("Score the reason."),
            ],
          }),
        );
        reasonScore = res.data.reasonScore;
        feedback = res.data.feedback;
      } catch {
        /* the verdict still counts; the true breaking point is shown */
      }
    this.judged.set(i, { right, reasonScore });
    const score = 0.5 * (right ? 1 : 0) + 0.5 * reasonScore;
    if (this.host.scope && score > 0)
      awardXp(this.host.handle, this.host.game, this.host.scope, "analogyJudged", score);
    this.host.send({
      type: "analogy.result",
      payload: { i, sound: card.sound, right, reasonScore, feedback, breaks: card.breaks },
    });
  }

  result(): ModeResult {
    const done = [...this.judged.values()];
    const right = done.filter((d) => d.right).length;
    const reasons = done.length ? done.reduce((a, d) => a + d.reasonScore, 0) / done.length : 0;
    return {
      kind: "analogy_lab",
      title: "Analogy lab",
      lines: done.length
        ? [
            `You judged ${done.length} of ${this.cards.length} analogies: ${right} called right.`,
            `Your "where it breaks" reasons scored ${Math.round(reasons * 100)}% on average.`,
          ]
        : ["No analogies were judged this time."],
      ...(done.length ? { score: 0.5 * (right / done.length) + 0.5 * reasons } : {}),
    };
  }
}

// --- V5-05 ELI ladder ----------------------------------------------------------

const ROUNDS = [
  { level: "eli5", audience: "a class of 5-year-olds" },
  { level: "eli15", audience: "a class of 15-year-olds" },
  { level: "expert", audience: "an expert panel (the Overachiever and the Skeptic)" },
] as const;

export class EliLadder {
  private round = 0;
  private scores: number[] = [];

  constructor(
    private readonly host: ModeHost,
    private readonly session: ClassSession,
  ) {}

  get level() {
    return ROUNDS[Math.min(this.round, ROUNDS.length - 1)]!.level;
  }

  start() {
    this.announce();
  }

  private announce() {
    const r = ROUNDS[this.round];
    if (!r) return;
    this.host.send({
      type: "eli.round",
      payload: { round: this.round + 1, of: ROUNDS.length, level: r.level, audience: r.audience },
    });
  }

  /** After each explanation I give: score its fit, then move to the next round. */
  async explained(text: string): Promise<{ expertDone: boolean } | null> {
    const r = ROUNDS[this.round];
    if (!r) return null;
    const c = this.session.currentConcept;
    let score = 0;
    let feedback: string;
    try {
      const res = await usage(this.session, () =>
        callStructured(this.host.factory, "modeJudge", {
          schema: ModeJudgementZ,
          name: "eli_fit",
          messages: [
            new SystemMessage(
              loadPrompt("eliJudge", {
                conceptTitle: c.title,
                keyFacts: keyFactList(c.keyFacts),
                audience: r.audience,
                eli5: r.level === "eli5",
                eli15: r.level === "eli15",
                expert: r.level === "expert",
                explanation: text,
              }),
            ),
            new HumanMessage("Score the fit."),
          ],
        }),
      );
      score = res.data.reasonScore;
      feedback = res.data.feedback;
    } catch {
      feedback = "The judge missed this one; it still counts for the class.";
    }
    this.scores.push(score);
    if (this.host.scope && score > 0)
      awardXp(this.host.handle, this.host.game, this.host.scope, "eliRound", score);
    this.host.send({ type: "eli.scored", payload: { round: this.round + 1, score, feedback } });
    const wasExpert = r.level === "expert";
    this.round++;
    this.announce();
    return { expertDone: wasExpert };
  }

  result(): ModeResult {
    const names = ["5-year-olds", "15-year-olds", "the experts"];
    return {
      kind: "eli_ladder",
      title: "ELI ladder",
      lines: this.scores.length
        ? this.scores.map((sc, i) => `To ${names[i]}: ${Math.round(sc * 100)}% fit.`)
        : ["No rounds were explained this time."],
      ...(this.scores.length
        ? { score: this.scores.reduce((a, b) => a + b, 0) / this.scores.length }
        : {}),
    };
  }
}

// --- V5-08 Substitute teacher -----------------------------------------------------

export class SubstituteLessonRunner {
  private lesson: SubstituteLesson["lines"] = [];
  private objected = new Set<number>();
  private finished = false;
  private score: { caught: number; missed: number; falseAlarms: number; score: number } | null =
    null;

  constructor(
    private readonly host: ModeHost,
    private readonly session: ClassSession,
  ) {}

  /** The server chooses which key facts get corrupted; the substitute only writes the lines. */
  async start() {
    const c = this.session.currentConcept;
    const n = Math.min(3, Math.max(2, Math.floor(c.keyFacts.length / 2)));
    const order = c.keyFacts.map((_, i) => i).sort(() => Math.random() - 0.5);
    const planted = order
      .slice(0, n)
      .map((i) => i + 1)
      .sort((a, b) => a - b);
    const res = await usage(this.session, () =>
      callStructured(this.host.factory, "substitute", {
        schema: SubstituteLessonZ,
        name: "substitute_lesson",
        messages: [
          new SystemMessage(
            loadPrompt("substitute", {
              conceptTitle: c.title,
              keyFacts: c.keyFacts.map((f, i) => `${i + 1}. ${f}`).join("\n"),
              lineCount: Math.max(6, c.keyFacts.length + 2),
              planted: planted.join(", "),
            }),
          ),
          new HumanMessage("Teach the lesson."),
        ],
      }),
    );
    this.lesson = res.data.lines;
    this.host.send({ type: "sub.lesson", payload: { lines: this.lesson.map((l) => l.text) } });
  }

  object(i: number) {
    const line = this.lesson[i];
    if (!line || this.objected.has(i) || this.finished) return;
    this.objected.add(i);
    this.host.send({
      type: "sub.objection",
      payload: { i, planted: line.planted, correction: line.planted ? line.correction : "" },
    });
  }

  finish() {
    if (this.finished || !this.lesson.length) return;
    this.finished = true;
    const planted = this.lesson.map((l, i) => (l.planted ? i : -1)).filter((i) => i >= 0);
    const caught = planted.filter((i) => this.objected.has(i)).length;
    const falseAlarms = [...this.objected].filter((i) => !this.lesson[i]!.planted).length;
    const missed = planted.length - caught;
    const score = Math.max(0, (planted.length ? caught / planted.length : 1) - 0.25 * falseAlarms);
    this.score = { caught, missed, falseAlarms, score };
    if (this.host.scope && caught)
      awardXp(this.host.handle, this.host.game, this.host.scope, "substituteCatch", caught);
    this.host.send({
      type: "sub.result",
      payload: {
        lines: this.lesson.map((l, i) => ({
          text: l.text,
          planted: l.planted,
          objected: this.objected.has(i),
          correction: l.correction,
        })),
        ...this.score,
      },
    });
  }

  result(): ModeResult {
    if (!this.score && this.lesson.length) this.finish();
    const r = this.score;
    return {
      kind: "substitute",
      title: "Substitute teacher",
      lines: r
        ? [
            `You caught ${r.caught} of ${r.caught + r.missed} planted mistake${r.caught + r.missed === 1 ? "" : "s"}${r.falseAlarms ? `, with ${r.falseAlarms} false alarm${r.falseAlarms === 1 ? "" : "s"}` : ""}.`,
            r.missed ? "The ones you missed are worth a second look in your notes." : "Sharp ears.",
          ]
        : ["The substitute didn't get to teach this time."],
      ...(r ? { score: r.score } : {}),
    };
  }
}
