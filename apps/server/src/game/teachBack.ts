import type { GameConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { cadetPack } from "./packs.js";
import { rng, seedFrom } from "./rng.js";

// Teach-back (V5-03): a student explains the concept back to the class. What
// they say is built from their own knowledge pack, so its gaps and errors are
// the ones my teaching left: what they retained is true, what they believe
// wrongly is false. The server keeps the truth; the LLM only phrases it.

export interface TeachBackLine {
  text: string;
  true: boolean;
}

export function planTeachBack(
  handle: DbHandle,
  game: GameConfig,
  input: {
    classroomId: string;
    cadetId: string;
    periodId: string;
    concept: { id: string; title: string; keyFacts: string[]; misconceptions: string[] };
  },
): TeachBackLine[] {
  const pack = cadetPack(handle, {
    classroomId: input.classroomId,
    cadetId: input.cadetId,
    concept: input.concept,
    purpose: `teachback:${input.periodId}`,
    memory: game.memory,
  });
  const r = rng(seedFrom(input.cadetId, input.periodId, "teachback"));
  const shuffle = <T>(xs: T[]) => [...xs].sort(() => r() - 0.5);
  const lines: TeachBackLine[] = [
    ...shuffle(pack.retained)
      .slice(0, 4)
      .map((text) => ({ text, true: true })),
    ...shuffle(pack.misconceptions)
      .slice(0, 2)
      .map((text) => ({ text, true: false })),
  ];
  // A student who took in nothing fills the gap the way students do: with a common mix-up.
  if (lines.length < 3)
    for (const m of shuffle(input.concept.misconceptions)) {
      if (lines.length >= 3 || lines.some((l) => l.text === m)) break;
      lines.push({ text: m, true: false });
    }
  return shuffle(lines);
}

export interface TeachBackScore {
  caught: number;
  missed: number;
  falseAlarms: number;
  /** caught / wrong lines, less a penalty for each false alarm, 0..1. */
  score: number;
}

export function scoreTeachBack(lines: TeachBackLine[], marked: number[]): TeachBackScore {
  const set = new Set(marked);
  const wrong = lines.map((l, i) => (!l.true ? i : -1)).filter((i) => i >= 0);
  const caught = wrong.filter((i) => set.has(i)).length;
  const falseAlarms = lines.filter((l, i) => l.true && set.has(i)).length;
  const missed = wrong.length - caught;
  const base = wrong.length ? caught / wrong.length : set.size ? 0 : 1;
  return {
    caught,
    missed,
    falseAlarms,
    score: Math.max(0, base - 0.25 * falseAlarms),
  };
}
