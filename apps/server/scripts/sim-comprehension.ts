// pnpm sim:comprehension [--base 0.25] [--search]
// Monte Carlo of the mirror formula (docs/03 §4.3) per archetype, against the
// D4 targets: average cadets reach 0.75 in 4–6 clear turns, lost_signal/quiet
// in 6–9, overachiever in 3–4, and wrong teaching never gets anyone there.
import { ARCHETYPES, LEARNING_STYLES, type Archetype, type GameConfig } from "@lumen/shared";
import { loadConfig } from "../src/config/load.js";
import {
  applyDelta,
  comprehensionDelta,
  type ComprehensionConfig,
  type TeachingQuality,
} from "../src/game/comprehension.js";
import { rng } from "../src/game/rng.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const game = loadConfig({ env: {} }).game;

const TARGETS: Partial<Record<Archetype, [number, number]>> = {
  skeptic: [4, 6],
  literalist: [4, 6],
  pragmatist: [4, 6],
  connector: [4, 6],
  lost_signal: [6, 9],
  quiet: [6, 9],
  overachiever: [3, 4],
};
const QUALITIES: Record<string, TeachingQuality> = {
  clear: { clarity: 0.85, accuracy: 1 },
  muddled: { clarity: 0.5, accuracy: 0.9 },
  wrong: { clarity: 0.7, accuracy: 0.3 },
};
// Messages with and without style cues; ~1 in 3 matches a given cadet.
const MESSAGES = [
  "For example, say you have four transactions.",
  "Think of it like a tournament bracket.",
  "Formally, the root is defined as the top hash.",
  "Picture the tree, level by level.",
  "The root goes in the block header.",
  "Changing one transaction changes the root.",
  "Each pair gets hashed together.",
];
const MAX_TURNS = 20;
const N = 400;

function turnsTo(
  target: number,
  archetype: Archetype,
  q: TeachingQuality,
  cfg: ComprehensionConfig,
  seed: number,
  startMinute: number,
): number[] {
  const r = rng(seed);
  const mean = game.archetypes[archetype];
  const out: number[] = [];
  for (let i = 0; i < N; i++) {
    const attention = Math.min(1, Math.max(0, mean.attention + (r() * 2 - 1) * game.traitSpread));
    const style = LEARNING_STYLES[Math.floor(r() * LEARNING_STYLES.length)]!;
    let c = 0;
    let turn = 0;
    while (c < target && turn < MAX_TURNS) {
      const message = MESSAGES[Math.floor(r() * MESSAGES.length)]!;
      c = applyDelta(
        c,
        comprehensionDelta(
          {
            teaching: q,
            cadet: { attention, skepticism: mean.skepticism, learningStyle: style },
            message,
            periodMinute: startMinute + turn * 0.75,
          },
          cfg,
        ).delta,
      );
      turn++;
    }
    out.push(c >= target ? turn : Infinity);
  }
  return out.sort((a, b) => a - b);
}

const median = (xs: number[]) => xs[Math.floor(xs.length / 2)]!;
const fmt = (x: number) => (x === Infinity ? "never" : String(x));

function evaluate(base: number, print: boolean): number {
  const cfg: ComprehensionConfig = {
    comprehension: { ...game.comprehension, base },
    fatigue: game.fatigue,
  };
  let miss = 0;
  if (print)
    console.log(
      `base ${base.toFixed(2)} · turns to ${game.comprehension.understoodAt} (median of ${N}; start minute 0 / 8)\n`,
    );
  if (print) console.log("archetype      clear    muddled  wrong    target");
  ARCHETYPES.forEach((a, ai) => {
    const row = Object.entries(QUALITIES).map(([, q], qi) =>
      [0, 8].map((m) =>
        median(turnsTo(game.comprehension.understoodAt, a, q, cfg, 1000 + ai * 10 + qi, m)),
      ),
    );
    const [clear0] = row[0]!;
    const target = TARGETS[a];
    if (target && (clear0! < target[0] || clear0! > target[1]))
      miss += Math.min(Math.abs(clear0! - target[0]), Math.abs(clear0! - target[1]));
    if (row[2]![0] !== Infinity && row[2]![0]! < 12) miss += 5; // mirror: wrong teaching must not get there quickly
    if (print) {
      const cell = (pair: number[]) => `${fmt(pair[0]!)}/${fmt(pair[1]!)}`.padEnd(9);
      console.log(
        `${a.padEnd(14)} ${cell(row[0]!)}${cell(row[1]!)}${cell(row[2]!)}${target ? `${target[0]}–${target[1]}${target[0] <= clear0! && clear0! <= target[1] ? " ✓" : " ✗"}` : "-"}`,
      );
    }
  });
  return miss;
}

if (args.includes("--search")) {
  let best = { base: 0, miss: Infinity };
  for (let b = 0.15; b <= 0.45001; b += 0.01) {
    const miss = evaluate(b, false);
    if (miss < best.miss) best = { base: Math.round(b * 100) / 100, miss };
  }
  console.log(`best base ${best.base} (target miss ${best.miss})\n`);
  evaluate(best.base, true);
} else {
  evaluate(Number(flag("base") ?? game.comprehension.base), true);
}
export type { GameConfig };
