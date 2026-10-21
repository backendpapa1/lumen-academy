import { rng, seedFrom } from "./rng.js";

// ADR-003: a cadet answers homework/exams only from what it "retained".
// The pack's size follows comprehension, so the mirror is mechanical.
//
// What a cadet retains is *what the teacher said*, not the source's sentence:
// the Director credits a key fact as covered when the gist was taught, but the
// key fact carries details the teacher may never have said ("two 32-byte child
// hashes concatenated into 64 bytes"). The key fact stays the answer key; the
// cadet only ever sees the teacher's own words for it.

export interface TaughtFact {
  fact: string;
  /** How often the Director credited this fact as covered in this classroom. */
  timesCovered: number;
  /** The teacher's lines that covered it, oldest first. */
  asTaught?: string[];
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
const STOP = new Set(
  "the a an and or of to in on is are was were be it its this that with for as at by from so then than when which who what each every one".split(
    " ",
  ),
);
const words = (s: string) =>
  new Set((s.toLowerCase().match(WORD) ?? []).filter((w) => w.length > 2 && !STOP.has(w)));

/** The teacher's sentence that best carries this fact (most recent on a tie). */
export function asTaughtSentence(lines: string[], fact: string): string | null {
  const target = words(fact);
  let best: { s: string; score: number } | null = null;
  for (const line of lines) {
    for (const raw of line.split(/(?<=[.?!])\s+/)) {
      const s = raw.trim();
      if (s.length < 8) continue;
      let score = 0;
      for (const w of words(s)) if (target.has(w)) score++;
      if (!best || score >= best.score) best = { s, score };
    }
  }
  return best && best.score > 0 ? best.s : (lines.at(-1)?.trim() ?? null);
}

export interface PackInput {
  conceptTitle: string;
  taught: TaughtFact[];
  comprehension: number; // 0..1
  misconceptions: string[];
  seed: { cadetId: string; conceptId: string; purpose: string };
}

export interface KnowledgePack {
  conceptTitle: string;
  retained: string[];
  forgotten: number;
  misconceptions: string[];
}

/** retained = round(comprehension × |taught|), drawn without replacement, weighted by coverage. */
export function knowledgePack(input: PackInput): KnowledgePack {
  const taught = input.taught.filter((t) => t.timesCovered > 0);
  const count = Math.round(Math.min(1, Math.max(0, input.comprehension)) * taught.length);
  const r = rng(seedFrom(input.seed.cadetId, input.seed.conceptId, input.seed.purpose));
  const pool = [...taught];
  const retained: string[] = [];
  while (retained.length < count && pool.length) {
    const total = pool.reduce((s, t) => s + t.timesCovered, 0);
    let pick = r() * total;
    let i = 0;
    while (i < pool.length - 1 && (pick -= pool[i]!.timesCovered) > 0) i++;
    const t = pool.splice(i, 1)[0]!;
    // In the teacher's words when we have them (older data may not).
    const said = t.asTaught?.length ? asTaughtSentence(t.asTaught, t.fact) : null;
    retained.push(said ?? t.fact);
  }
  return {
    conceptTitle: input.conceptTitle,
    retained,
    forgotten: taught.length - retained.length,
    misconceptions: input.misconceptions,
  };
}

export function formatPack(packs: KnowledgePack[]): string {
  return packs
    .map((p) =>
      [
        `## ${p.conceptTitle}`,
        p.retained.length
          ? p.retained.map((f) => `- ${f}`).join("\n")
          : "- (you remember nothing specific about this)",
        ...(p.misconceptions.length
          ? ["You also believe (and are sure of):", ...p.misconceptions.map((m) => `- ${m}`)]
          : []),
      ].join("\n"),
    )
    .join("\n\n");
}
