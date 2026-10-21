import type { DbHandle } from "../db/client.js";
import { isKind } from "./arcs.js";

// Teaching-style profile (V7-07): how I teach, from my turns across classes.
// The server counts; the LLM only puts the numbers into three plain sentences
// and one suggestion (styleCoach, Zod-validated, and its numbers must be ours).

const ANALOGY =
  /\b(it'?s like|is like|just like|like a|imagine|think of (it|this) as|picture (a|an|this))\b/i;
const EXAMPLE =
  /\b(for example|for instance|e\.g\.|say you have|let'?s say|suppose|such as|take a)\b/i;
const DEFINITION =
  /\b(\w+ (is|are) (a|an|the|called|when|what|how)\b|means\b|we call|is defined as|stands for)\b/i;
const CHECK =
  /(\?\s*$)|\b(does that make sense|any questions|who can tell me|what do you think|can (someone|anyone)|are you with me|questions so far)\b/i;
const CORRECTION_WORDS =
  /\b(no[,.]|not quite|actually|that'?s (wrong|not right)|incorrect|isn'?t right)\b/i;

export interface StyleStats {
  turns: number;
  /** Shares of my explanations, 0..1. */
  analogies: number;
  examples: number;
  definitions: number;
  /** Mean words per explanation. */
  words: number;
  /** Share of my turns that check for understanding (a question to the class). */
  checks: number;
  /** Subject terms per 100 words that I never defined on the glossary wall. */
  jargon: number;
  /** Replies to a student's wrong claim or objection, and how many of those were kind. */
  corrections: number;
  kindCorrections: number;
}

/** Subject vocabulary: words from the curriculum's key facts and titles. */
function subjectTerms(handle: DbHandle): Set<string> {
  const rows = handle.sqlite
    .prepare("SELECT title, key_facts_json k FROM concepts")
    .all() as Array<{
    title: string;
    k: string;
  }>;
  const terms = new Set<string>();
  for (const r of rows)
    for (const w of `${r.title} ${(JSON.parse(r.k) as string[]).join(" ")}`
      .toLowerCase()
      .match(/[a-z][a-z0-9-]{5,}/g) ?? [])
      terms.add(w);
  return terms;
}

export function styleStats(handle: DbHandle): StyleStats {
  const { sqlite } = handle;
  const mine = sqlite
    .prepare(
      `SELECT m.text, m.kind, m.reply_to_id r, (SELECT c.kind FROM messages c WHERE c.id = m.reply_to_id) replyKind
       FROM messages m WHERE m.speaker = 'teacher' AND m.kind IN ('lecture','answer') AND m.text NOT LIKE '(draws%'`,
    )
    .all() as Array<{ text: string; kind: string; r: string | null; replyKind: string | null }>;
  const n = mine.length;
  const share = (re: RegExp) => (n ? mine.filter((m) => re.test(m.text)).length / n : 0);
  const words = mine.map((m) => m.text.split(/\s+/).filter(Boolean).length);
  const defined = new Set(
    (sqlite.prepare("SELECT term FROM glossary_terms").all() as Array<{ term: string }>).flatMap(
      (t) => t.term.split(/\s+/),
    ),
  );
  const subject = subjectTerms(handle);
  let jargonHits = 0;
  const totalWords = words.reduce((a, b) => a + b, 0);
  // Each undefined term counts once per turn: saying "transaction" twice isn't twice the jargon.
  for (const m of mine)
    for (const w of new Set(m.text.toLowerCase().match(/[a-z][a-z0-9-]{5,}/g) ?? []))
      if (subject.has(w) && !defined.has(w)) jargonHits++;
  const corrections = mine.filter(
    (m) =>
      m.replyKind &&
      ["claim", "objection"].includes(m.replyKind) &&
      (CORRECTION_WORDS.test(m.text) || isKind(m.text)),
  );
  return {
    turns: n,
    analogies: share(ANALOGY),
    examples: share(EXAMPLE),
    definitions: share(DEFINITION),
    words: words.length ? totalWords / words.length : 0,
    checks: share(CHECK),
    jargon: totalWords ? (jargonHits / totalWords) * 100 : 0,
    corrections: corrections.length,
    kindCorrections: corrections.filter((m) => isKind(m.text)).length,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The numbers as the facts the writer may use (and nothing else). */
export function statLines(s: StyleStats): string[] {
  return [
    `Teaching turns analysed: ${s.turns}`,
    `Turns with an analogy: ${pct(s.analogies)}`,
    `Turns with a worked example: ${pct(s.examples)}`,
    `Turns with a definition: ${pct(s.definitions)}`,
    `Average explanation length: ${Math.round(s.words)} words`,
    `Turns that check for understanding: ${pct(s.checks)}`,
    `Undefined subject terms per 100 words: ${s.jargon.toFixed(1)}`,
    `Replies correcting a student's wrong claim: ${s.corrections}, of which kind: ${s.kindCorrections}`,
  ];
}

/** Every number in the writer's text must be one we gave it (no invented stats). */
export function numbersAreOurs(text: string, lines: string[]): boolean {
  const ours = new Set(lines.join(" ").match(/\d+(\.\d+)?/g) ?? []);
  return (text.match(/\d+(\.\d+)?/g) ?? []).every((x) => ours.has(x));
}

/** Plain sentences without the LLM (too few turns, or the writer failed the check). */
export function fallbackProfile(s: StyleStats): { sentences: string[]; suggestion: string } {
  const top = [
    ["analogies", s.analogies],
    ["worked examples", s.examples],
    ["definitions", s.definitions],
  ].sort((a, b) => (b[1] as number) - (a[1] as number)) as Array<[string, number]>;
  return {
    sentences: [
      `You lean on ${top[0]![0]} (${pct(top[0]![1])} of your turns) more than ${top[2]![0]} (${pct(top[2]![1])}).`,
      `Your explanations run about ${Math.round(s.words)} words, and ${pct(s.checks)} of your turns check that the class is with you.`,
      s.corrections
        ? `You corrected a wrong claim ${s.corrections} times, kindly in ${s.kindCorrections}.`
        : `You haven't had to correct a student's wrong claim yet.`,
    ],
    suggestion:
      s.checks < 0.15
        ? "Ask the class a quick question after each new idea."
        : s.examples < 0.15
          ? "Add one worked example per concept."
          : "Keep going: try a Socratic class to stretch your questioning.",
  };
}
