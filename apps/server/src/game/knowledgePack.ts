import { rng, seedFrom } from "./rng.js";

// ADR-003: a cadet answers homework/exams only from what it "retained".
// The pack's size follows comprehension, so the mirror is mechanical.

export interface TaughtFact {
  fact: string;
  /** How often the Director credited this fact as covered in this classroom. */
  timesCovered: number;
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
    retained.push(pool.splice(i, 1)[0]!.fact);
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
