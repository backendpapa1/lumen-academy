import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ARCHETYPE_INFO, type Archetype, type GameConfig } from "@lumen/shared";
import { z } from "zod";
import { gradeAnswer } from "../agents/assessment.js";
import { callStructured } from "../agents/harness.js";
import { loadPrompt } from "../agents/prompts/load.js";
import type { DbHandle } from "../db/client.js";
import { newId } from "../db/ids.js";
import type { ModelFactory } from "../models/factory.js";
import type { Misconception } from "./ledger.js";
import { rng, seedFrom } from "./rng.js";
import { awardXp, type XpScope } from "./xp.js";

// Random events (docs/02 §6): at most one per period, on a random teaching
// turn. Pop quiz (the Grader scores me), hologram glitch (catch the subtly
// wrong repeat), power flicker (a misconception whispers to a neighbour),
// visiting inspector (the Dean watches my next explanations, then gives feedback).

/** How many of my explanations the Dean watches. */
export const INSPECTION_TURNS = 3;

export type EventKind = "pop_quiz" | "glitch" | "power_flicker" | "inspector";

export interface PendingEvent {
  id: string;
  kind: EventKind;
  /** Absent for the inspector (the Dean isn't a cadet). */
  cadetId?: string;
  text: string;
  toCadetId?: string;
  seconds: number;
  /** Server-only: facts for grading, or what the glitch got wrong. */
  facts: string[];
  flaw?: string;
}

export interface EventContext {
  handle: DbHandle;
  factory: ModelFactory;
  game: GameConfig;
  periodId: string;
  classroomId: string;
  concept: { id: string; title: string; keyFacts: string[] };
  turnOrd: number;
  cadets: Array<{ id: string; name: string; archetype: Archetype }>;
}

const DeanZ = z.object({
  verdict: z.string().min(2).max(300),
  strengths: z.array(z.string().max(300)).min(1).max(3),
  improve: z.array(z.string().max(300)).min(1).max(3),
  tip: z.string().min(2).max(300),
});

const GlitchZ = z.object({ line: z.string().min(8).max(400), flaw: z.string().min(4).max(300) });

/** The turn this period's event fires on, fixed by the period id (or null: no event). */
export function eventTurn(game: GameConfig, periodId: string): number | null {
  const e = game.events;
  if (!e.enabled || e.maxPerPeriod < 1 || !e.kinds.length) return null;
  const r = rng(seedFrom(periodId, "event-turn"));
  return e.earliestTurn + Math.floor(r() * (e.latestTurn - e.earliestTurn + 1));
}

/** Decides and prepares this turn's event, if one is due. Saved on the period so it never repeats. */
export async function maybeStartEvent(ctx: EventContext): Promise<PendingEvent | null> {
  const { handle, game } = ctx;
  if (ctx.turnOrd !== eventTurn(game, ctx.periodId)) return null;
  const already = handle.sqlite
    .prepare("SELECT random_event FROM periods WHERE id = ?")
    .get(ctx.periodId) as { random_event: string | null };
  if (already?.random_event || !ctx.cadets.length) return null;
  const r = rng(seedFrom(ctx.periodId, "event-kind"));
  const kinds = [...game.events.kinds].sort(() => r() - 0.5);
  for (const kind of kinds) {
    const ev = await prepare(kind, ctx, r).catch(() => null);
    if (!ev) continue;
    handle.sqlite
      .prepare("UPDATE periods SET random_event = ? WHERE id = ?")
      .run(kind, ctx.periodId);
    return ev;
  }
  return null;
}

async function prepare(
  kind: EventKind,
  ctx: EventContext,
  r: () => number,
): Promise<PendingEvent | null> {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const { sqlite } = ctx.handle;
  if (kind === "pop_quiz") {
    const c = pick(ctx.cadets);
    return {
      id: newId("message"),
      kind,
      cadetId: c.id,
      text: `Pop quiz, Headmaster! In a few sentences: explain "${ctx.concept.title}" so I'd get it.`,
      seconds: 90,
      facts: ctx.concept.keyFacts,
    };
  }
  if (kind === "inspector") {
    return {
      id: newId("message"),
      kind,
      text: `The Dean is observing your next ${INSPECTION_TURNS} explanations.`,
      seconds: 0,
      facts: ctx.concept.keyFacts,
    };
  }
  if (kind === "glitch") {
    const said = sqlite
      .prepare(
        "SELECT text FROM messages WHERE period_id = ? AND speaker = 'teacher' AND kind IN ('lecture','answer') AND length(text) > 40 ORDER BY created_at",
      )
      .all(ctx.periodId) as Array<{ text: string }>;
    if (said.length < 2) return null;
    const c = pick(ctx.cadets);
    const original = pick(said.slice(0, -1)).text;
    const g = (
      await callStructured(ctx.factory, "cadetTalk", {
        schema: GlitchZ,
        name: "glitch",
        messages: [
          new SystemMessage(
            loadPrompt("glitch", {
              original,
              facts: ctx.concept.keyFacts.map((f) => `- ${f}`).join("\n"),
              name: c.name,
              archetype: ARCHETYPE_INFO[c.archetype].label,
            }),
          ),
          new HumanMessage("Write the glitched line."),
        ],
      })
    ).data;
    return {
      id: newId("message"),
      kind,
      cadetId: c.id,
      text: g.line,
      seconds: 30,
      facts: [],
      flaw: g.flaw,
    };
  }
  // Power flicker: someone's misconception on this concept reaches a neighbour.
  const holders = ctx.cadets
    .map((c) => {
      const row = sqlite
        .prepare(
          "SELECT misconceptions_json FROM ledger_entries WHERE cadet_id = ? AND concept_id = ?",
        )
        .get(c.id, ctx.concept.id) as { misconceptions_json: string } | undefined;
      return { c, held: row ? (JSON.parse(row.misconceptions_json) as Misconception[]) : [] };
    })
    .filter((x) => x.held.length);
  if (!holders.length) return null;
  const from = pick(holders);
  const belief = pick(from.held).text;
  const others = ctx.cadets.filter((c) => c.id !== from.c.id);
  if (!others.length) return null;
  const to = pick(others);
  const row = sqlite
    .prepare("SELECT misconceptions_json FROM ledger_entries WHERE cadet_id = ? AND concept_id = ?")
    .get(to.id, ctx.concept.id) as { misconceptions_json: string } | undefined;
  const held = row ? (JSON.parse(row.misconceptions_json) as Misconception[]) : [];
  if (!held.some((m) => m.text === belief)) {
    held.push({ text: belief, source: "spread", since: new Date().toISOString() });
    if (row)
      sqlite
        .prepare(
          "UPDATE ledger_entries SET misconceptions_json = ? WHERE cadet_id = ? AND concept_id = ?",
        )
        .run(JSON.stringify(held), to.id, ctx.concept.id);
    else
      sqlite
        .prepare(
          "INSERT INTO ledger_entries (cadet_id, concept_id, comprehension, exposures, misconceptions_json) VALUES (?, ?, 0, 0, ?)",
        )
        .run(to.id, ctx.concept.id, JSON.stringify(held));
  }
  return {
    id: newId("message"),
    kind,
    cadetId: from.c.id,
    toCadetId: to.id,
    text: belief,
    seconds: 6,
    facts: [],
  };
}

/** My answer to a pop quiz, or my verdict on a glitch. */
export async function resolveEvent(
  ev: PendingEvent,
  answer: { text?: string; wrong?: boolean },
  deps: { handle: DbHandle; factory: ModelFactory; game: GameConfig; scope: XpScope },
): Promise<{ score?: number; caught?: boolean; explanation: string; xp: number }> {
  if (ev.kind === "pop_quiz") {
    const text = answer.text?.trim() ?? "";
    if (!text) return { score: 0, explanation: "No answer this time.", xp: 0 };
    const g = await gradeAnswer(deps.factory, ev.text, ev.facts, text);
    const xp =
      g.score > 0 ? awardXp(deps.handle, deps.game, deps.scope, "popQuizPerPoint", g.score) : 0;
    return { score: g.score, explanation: g.rationale || "Graded against the source.", xp };
  }
  if (ev.kind === "glitch") {
    const caught = answer.wrong === true;
    const xp = caught ? awardXp(deps.handle, deps.game, deps.scope, "glitchCaught") : 0;
    return { caught, explanation: ev.flaw ?? "", xp };
  }
  return { explanation: "Correct the whispered idea in your next explanation.", xp: 0 };
}

/** The Dean's report on the explanations it watched (the dean agent, docs/03). */
export async function inspect(
  ev: PendingEvent,
  watched: Array<{ text: string; accuracy: number; clarity: number }>,
  conceptTitle: string,
  factory: ModelFactory,
): Promise<{
  explanation: string;
  xp: 0;
  feedback: { strengths: string[]; improve: string[]; tip: string };
}> {
  const d = (
    await callStructured(factory, "dean", {
      schema: DeanZ,
      name: "dean_report",
      messages: [
        new SystemMessage(
          loadPrompt("dean", {
            conceptTitle,
            facts: ev.facts.map((f) => `- ${f}`).join("\n"),
            lines: watched.map((w, i) => `${i + 1}. "${w.text}"`).join("\n"),
            measures: watched
              .map(
                (w, i) =>
                  `${i + 1}: accuracy ${w.accuracy.toFixed(2)}, clarity ${w.clarity.toFixed(2)}`,
              )
              .join("; "),
          }),
        ),
        new HumanMessage("Write your inspection report."),
      ],
    })
  ).data;
  return {
    explanation: d.verdict,
    xp: 0,
    feedback: { strengths: d.strengths.slice(0, 2), improve: d.improve.slice(0, 2), tip: d.tip },
  };
}
