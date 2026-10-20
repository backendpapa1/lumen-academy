import { z } from "zod";

// Agent output schemas consumed by the game (docs/03 §4.2, ADR-002).
// Every one is Zod-validated server-side (CLAUDE.md).

export const ARCHETYPES = [
  "skeptic",
  "lost_signal",
  "overachiever",
  "literalist",
  "pragmatist",
  "connector",
  "quiet",
  "saboteur",
] as const;
export const ArchetypeZ = z.enum(ARCHETYPES);
export type Archetype = z.infer<typeof ArchetypeZ>;

export const REACTION_STATES = [
  "attentive",
  "confused",
  "excited",
  "bored",
  "skeptical",
  "notetaking",
] as const;
export const ReactionStateZ = z.enum(REACTION_STATES);
export type ReactionState = z.infer<typeof ReactionStateZ>;

/** Emote shown over a cadet for each reaction (docs/02 §3.2). */
export const REACTION_GLYPHS: Record<ReactionState, string> = {
  attentive: "",
  confused: "?",
  excited: "!",
  bored: "…",
  skeptical: "⨯",
  notetaking: "✎",
};

export const HAND_INTENTS = [
  "clarify",
  "challenge",
  "example",
  "connect",
  "eli10",
  "deeper",
  "wrong_claim",
] as const;
export const HandIntentZ = z.enum(HAND_INTENTS);
export type HandIntent = z.infer<typeof HandIntentZ>;

export const LEARNING_STYLES = ["example-first", "analogy", "formal", "visual"] as const;
export const LearningStyleZ = z.enum(LEARNING_STYLES);
export type LearningStyle = z.infer<typeof LearningStyleZ>;

/** Compact cadet form sent to the Crowd Reactor and Director (docs/06 §4). */
export interface CadetCard {
  id: string;
  name: string;
  archetype: Archetype;
  attention: number;
  skepticism: number;
  learningStyle: LearningStyle;
  /** Comprehension of the current concept, 0..1. */
  comprehension: number;
  /** Misconceptions on the current concept, max 2. */
  misconceptions: string[];
  lastState: ReactionState;
  /** Fairness: the reactor prefers cadets who haven't spoken lately. */
  spokeTurnsAgo: number | null;
}

/** Fast path: what the class visibly does this turn (role `fastest`). */
export const CrowdReactionZ = z.object({
  // No glyph: it follows from the state, so the client derives it (REACTION_GLYPHS)
  // instead of paying output tokens for it on the latency-critical path.
  reactions: z.array(z.object({ cadetId: z.string(), state: ReactionStateZ })),
  handRaises: z
    .array(
      z.object({
        cadetId: z.string(),
        intent: HandIntentZ,
        preview: z.string().max(80), // shown in the queue chip
        urgency: z.number().min(0).max(1),
      }),
    )
    .max(3),
});
export type CrowdReaction = z.infer<typeof CrowdReactionZ>;

/**
 * Slow path: how well I taught, and how each cadet's understanding moves (role `standard`).
 * Deliberately lenient on ranges and lengths: a re-ask costs seconds, and the
 * server clamps everything anyway (normalizeTeachingAnalysis + the comprehension
 * formula, docs/03 §4.3). Only shape errors trigger a re-ask.
 */
export const TeachingAnalysisZ = z.object({
  conceptIds: z.array(z.string()),
  teaching: z.object({
    accuracy: z.number(), // 0..1 vs source key facts
    clarity: z.number(), // 0..1
    coverage: z.array(z.string()), // key facts covered this turn (verbatim from the list)
    errors: z.array(z.object({ claim: z.string(), correction: z.string(), citation: z.string() })),
  }),
  ledgerDeltas: z.array(
    z.object({
      cadetId: z.string(),
      conceptId: z.string(),
      comprehensionDelta: z.number(), // proposal; the server computes the final value
      newMisconception: z.string().optional(),
      resolvedMisconception: z.string().optional(),
    }),
  ),
});

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Applies the documented bounds (docs/03 §4.2) after a lenient parse. */
export function normalizeTeachingAnalysis(a: TeachingAnalysis): TeachingAnalysis {
  return {
    conceptIds: a.conceptIds.slice(0, 3),
    teaching: {
      accuracy: clamp(a.teaching.accuracy, 0, 1),
      clarity: clamp(a.teaching.clarity, 0, 1),
      coverage: a.teaching.coverage,
      errors: a.teaching.errors.slice(0, 3),
    },
    ledgerDeltas: a.ledgerDeltas.map((d) => ({
      ...d,
      comprehensionDelta: clamp(d.comprehensionDelta, -0.3, 0.4),
      ...(d.newMisconception ? { newMisconception: d.newMisconception.slice(0, 160) } : {}),
      ...(d.resolvedMisconception
        ? { resolvedMisconception: d.resolvedMisconception.slice(0, 160) }
        : {}),
    })),
  };
}
export type TeachingAnalysis = z.infer<typeof TeachingAnalysisZ>;

// --- Curriculum (docs/03 §3.2) ------------------------------------------------

export const ConceptZ = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  keyFacts: z.array(z.string().min(1)).min(2),
  misconceptions: z.array(z.string()).default([]),
  prerequisites: z.array(z.string()).default([]), // concept titles
  citations: z.array(z.string()).min(1), // chunk ids
  difficulty: z.number(),
});
export type Concept = z.infer<typeof ConceptZ>;

export const CurriculumZ = z.object({
  modules: z
    .array(
      z.object({
        title: z.string().min(1),
        goal: z.string().default(""),
        concepts: z.array(ConceptZ).min(1),
      }),
    )
    .min(1),
});
export type Curriculum = z.infer<typeof CurriculumZ>;

/** Documented bounds (docs/03 §3.2), applied after a lenient parse. */
export function normalizeCurriculum(c: Curriculum): Curriculum {
  return {
    modules: c.modules.slice(0, 10).map((m) => ({
      title: m.title.trim(),
      goal: m.goal.trim(),
      concepts: m.concepts.map((k) => ({
        title: k.title.trim().slice(0, 60),
        summary: k.summary.trim().slice(0, 400),
        keyFacts: k.keyFacts.slice(0, 8).map((f) => f.trim().slice(0, 200)),
        misconceptions: k.misconceptions.slice(0, 5).map((f) => f.trim().slice(0, 200)),
        prerequisites: k.prerequisites,
        citations: [...new Set(k.citations)],
        difficulty: Math.min(5, Math.max(1, Math.round(k.difficulty))),
      })),
    })),
  };
}
