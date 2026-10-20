import {
  LEARNING_STYLES,
  type Archetype,
  type GameConfig,
  type LearningStyle,
} from "@lumen/shared";
import { rng } from "./rng.js";

// Registration in code (docs/03 §5.2): everything random is seeded and
// reproducible from the classroom seed. The LLM only writes flavour.

export type Difficulty = "gentle" | "standard" | "ruthless";
type RegistrationConfig = Pick<
  GameConfig,
  "cohort" | "registration" | "archetypes" | "traitSpread"
>;

export interface CadetPlan {
  seat: number; // 0..14
  archetype: Archetype;
  traits: {
    curiosity: number;
    skepticism: number;
    attention: number;
    verbosity: number;
    confidence: number;
    humor: number;
  };
  learningStyle: LearningStyle;
  homeworld: string;
  appearance: { heritageHint: string; genderPresentation: string; ageRange: string };
}

/** Integer from a triangular distribution on [min, max] peaking at mode (inverse CDF). */
export function triangularInt(r: () => number, min: number, mode: number, max: number): number {
  const u = r();
  const a = min - 0.5;
  const b = max + 0.5;
  const c = mode;
  const fc = (c - a) / (b - a);
  const x =
    u < fc ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
  return Math.min(max, Math.max(min, Math.round(x)));
}

function weighted<T extends string>(r: () => number, weights: Partial<Record<T, number>>): T {
  const entries = Object.entries(weights).filter(([, w]) => (w as number) > 0) as Array<
    [T, number]
  >;
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let pick = r() * total;
  for (const [k, w] of entries) if ((pick -= w) < 0) return k;
  return entries.at(-1)![0];
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const clamp01 = (x: number) => Math.min(1, Math.max(0, Math.round(x * 100) / 100));

export function cohortArchetypes(
  size: number,
  difficulty: Difficulty,
  cfg: RegistrationConfig,
  r: () => number,
  opts: { saboteurUnlocked?: boolean } = {},
): Archetype[] {
  const out: Archetype[] = cfg.registration.guaranteed
    .filter((g) => size >= g.minSize)
    .map((g) => g.archetype)
    .slice(0, size);
  const weights = { ...cfg.registration.weights[difficulty] };
  if (!opts.saboteurUnlocked) delete weights.saboteur;
  while (out.length < size) out.push(weighted(r, weights));
  return out;
}

export function planCohort(
  seed: number,
  difficulty: Difficulty,
  cfg: RegistrationConfig,
  opts: { saboteurUnlocked?: boolean; size?: number } = {},
): CadetPlan[] {
  const r = rng(seed);
  const size = opts.size ?? triangularInt(r, cfg.cohort.min, cfg.cohort.mode, cfg.cohort.max);
  const archetypes = cohortArchetypes(size, difficulty, cfg, r, opts);
  // Shuffle arrival order (Fisher–Yates) so guaranteed archetypes don't always arrive first.
  for (let i = archetypes.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [archetypes[i], archetypes[j]] = [archetypes[j]!, archetypes[i]!];
  }
  const seats = Array.from({ length: cfg.cohort.max }, (_, i) => i);
  for (let i = seats.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [seats[i], seats[j]] = [seats[j]!, seats[i]!];
  }
  const jitter = () => (r() * 2 - 1) * cfg.traitSpread;
  return archetypes.map((archetype, i) => {
    const mean = cfg.archetypes[archetype];
    return {
      seat: seats[i]!,
      archetype,
      traits: {
        curiosity: clamp01(mean.curiosity + jitter()),
        skepticism: clamp01(mean.skepticism + jitter()),
        attention: clamp01(mean.attention + jitter()),
        verbosity: clamp01(mean.verbosity + jitter()),
        confidence: clamp01(mean.confidence + jitter()),
        humor: clamp01(mean.humor + jitter()),
      },
      learningStyle: pick(r, LEARNING_STYLES),
      homeworld: pick(r, cfg.registration.homeworlds),
      appearance: {
        heritageHint: pick(r, cfg.registration.heritage),
        genderPresentation: pick(r, cfg.registration.genderPresentation),
        ageRange: pick(r, cfg.registration.ageRange),
      },
    };
  });
}
