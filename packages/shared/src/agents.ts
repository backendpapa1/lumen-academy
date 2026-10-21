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
  /** V4-04: everyday interests, for examples that land. */
  interests?: string[];
  /** V4-03: where they are in their growth arc, as a prompt line. */
  arc?: string;
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
  /** V4-01: optional, and only when the server offered one this turn. */
  peerBeat: z
    .object({ speakerId: z.string(), listenerId: z.string(), preview: z.string().max(80) })
    .optional(),
});
export type CrowdReaction = z.infer<typeof CrowdReactionZ>;

/** V4-01: the reactor may suggest one student turning to another (the server decides). */
export const PeerBeatZ = z.object({
  speakerId: z.string(),
  listenerId: z.string(),
  preview: z.string().max(80),
});
export type PeerBeat = z.infer<typeof PeerBeatZ>;

/** V4-02: was a classmate's explanation right, by the key facts? */
export const PeerVerdictZ = z.object({
  verdict: z.enum(["correct", "wrong", "neither"]),
  /** For "wrong": the mistaken idea the listener might now hold, in plain words. */
  misconception: z.string().max(160).optional(),
});
export type PeerVerdict = z.infer<typeof PeerVerdictZ>;

/** V5-03: the student's own statements, phrased as an explanation (same count, same order). */
/** V5-04: the Connector's analogies; "sound" and "breaks" stay on the server. */
export const AnalogySetZ = z.object({
  analogies: z
    .array(
      z.object({
        text: z.string().min(1).max(400),
        sound: z.boolean(),
        breaks: z.string().max(300),
      }),
    )
    .min(2)
    .max(4),
});
export type AnalogySet = z.infer<typeof AnalogySetZ>;
/** V5-04/05: a judged reason or explanation, 0..1 with one line of feedback. */
export const ModeJudgementZ = z.object({
  reasonScore: z.number().min(0).max(1),
  feedback: z.string().max(300),
});
export type ModeJudgement = z.infer<typeof ModeJudgementZ>;

/** V5-08: the substitute's lesson; which lines are planted stays on the server. */
export const SubstituteLessonZ = z.object({
  lines: z
    .array(
      z.object({
        text: z.string().min(1).max(400),
        planted: z.boolean(),
        correction: z.string().max(300).default(""),
      }),
    )
    .min(3)
    .max(12),
});
export type SubstituteLesson = z.infer<typeof SubstituteLessonZ>;

/** V5-09: the guest's answer, grounded in my sources (citations are chunk ids). */
export const GuestAnswerZ = z.object({
  answer: z.string().min(1).max(1500),
  citations: z.array(z.string()).min(1).max(6),
});

/** V5-10: one turn from the parent in a parent–teacher meeting. */
export const ParentTurnZ = z.object({
  reply: z.string().min(1).max(600),
  satisfied: z.boolean(),
  pushback: z.boolean(),
});
export type ParentTurn = z.infer<typeof ParentTurnZ>;

/** V7-07: the teaching-style profile, written from the server's numbers only. */
export const StyleProfileZ = z.object({
  sentences: z.array(z.string().min(1).max(300)).length(3),
  suggestion: z.string().min(1).max(300),
});

export const TeachBackPhrasingZ = z.object({ sentences: z.array(z.string().min(1).max(300)) });

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
  /** V6-08: terms I defined in this message, in my words, checked against the key facts. */
  definitions: z
    .array(
      z.object({
        term: z.string().min(1).max(60),
        definition: z.string().min(1).max(300),
        agrees: z.boolean(),
        note: z.string().max(200).optional(),
      }),
    )
    .max(3)
    .optional(),
  /** V5-02: in a Socratic class, what kind of question I asked. */
  question: z.object({ kind: z.enum(["diagnostic", "leading", "closed", "statement"]) }).optional(),
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
    ...(a.question ? { question: a.question } : {}),
    ...(a.definitions?.length ? { definitions: a.definitions.slice(0, 3) } : {}),
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

/**
 * One chapter of a book, read by the Chapter Analyst (book-by-book curriculum):
 * the module it becomes and its concepts, or why it isn't teachable (front or
 * back matter, a list of links…).
 */
export const ChapterAnalysisZ = z.object({
  teachable: z.boolean(),
  reason: z.string().default(""),
  moduleTitle: z.string().default(""),
  goal: z.string().default(""),
  concepts: z.array(ConceptZ).default([]),
});
export type ChapterAnalysis = z.infer<typeof ChapterAnalysisZ>;

/** The Curriculum Connector's pass over every book: links across books, and duplicates. */
export const CurriculumLinksZ = z.object({
  prerequisites: z
    .array(z.object({ concept: z.string(), needs: z.array(z.string()).max(4) }))
    .default([]),
  duplicates: z.array(z.object({ drop: z.string(), keep: z.string() })).default([]),
});
export type CurriculumLinks = z.infer<typeof CurriculumLinksZ>;

/** Curriculum as exported for hand editing (C-2): existing items carry their id. */
export const EditableCurriculumZ = z.object({
  modules: z
    .array(
      z.object({
        id: z.string().optional(),
        title: z.string().min(1),
        goal: z.string().default(""),
        /** The book this module was built from (read-only here: edits keep it). */
        unit: z
          .object({ sourceId: z.string().nullable(), title: z.string() })
          .nullable()
          .optional(),
        concepts: z.array(ConceptZ.extend({ id: z.string().optional() })).min(1),
      }),
    )
    .min(1),
});
export type EditableCurriculum = z.infer<typeof EditableCurriculumZ>;

// --- Archetypes & registration ------------------------------------------------

/** docs/03 §5.1 — label, accent colour and a behaviour brief used in prompts. */
export const ARCHETYPE_INFO: Record<Archetype, { label: string; accent: string; brief: string }> = {
  skeptic: {
    label: "Skeptic",
    accent: "#B86E00",
    brief: "Demands the why; challenges hand-waving.",
  },
  lost_signal: {
    label: "Lost Signal",
    accent: "#D93A26",
    brief: "Has realistic misunderstandings; mixes up terms.",
  },
  overachiever: {
    label: "Overachiever",
    accent: "#6B4EFF",
    brief: "Reads ahead; connects to the next concept.",
  },
  literalist: {
    label: "Literalist",
    accent: "#0A7FB0",
    brief: "Wants it explained like they're 10; trips on jargon.",
  },
  pragmatist: {
    label: "Pragmatist",
    accent: "#2F8A2F",
    brief: "Asks where this is used in the real world.",
  },
  connector: {
    label: "Connector",
    accent: "#0E8A80",
    brief: "Draws analogies to other fields, sometimes bad ones.",
  },
  quiet: {
    label: "Quiet One",
    accent: "#5B6488",
    brief: "Rarely speaks; exams reveal what they absorbed.",
  },
  saboteur: {
    label: "Saboteur",
    accent: "#C2338A",
    brief: "Confidently states plausible wrong claims.",
  },
};

/** LLM-written flavour for one batch of planned cadets (Registrar). */
export const CadetFlavourZ = z.object({
  cadets: z.array(
    z.object({
      index: z.number().int(),
      name: z.string().min(1),
      quirk: z.string().min(1),
      voiceNotes: z.string().min(1),
      backstory: z.string().default(""),
      visualQuirk: z.string().default(""),
      hair: z.string().default(""),
      /** V4-04: one or two everyday interests. */
      interests: z.array(z.string().max(30)).max(3).default([]),
      /** The speaking voice that fits the name, so the voice and drawing match it. */
      voice: z.enum(["higher", "lower"]).optional().catch(undefined),
    }),
  ),
});
export type CadetFlavour = z.infer<typeof CadetFlavourZ>;

/** Voice casting for students registered before the Registrar noted a voice. */
export const VoiceCastZ = z.object({
  students: z.array(z.object({ index: z.number().int(), voice: z.enum(["higher", "lower"]) })),
});
export type VoiceCast = z.infer<typeof VoiceCastZ>;

// --- Cadet speech (docs/03 §4.4) ---------------------------------------------

export const UTTERANCE_KINDS = [
  "question",
  "answer",
  "objection",
  "example_request",
  "claim",
  "thanks",
] as const;
export const MOODS = ["curious", "confused", "excited", "doubtful", "proud", "sheepish"] as const;

export const CadetUtteranceZ = z.object({
  text: z.string().min(1).max(600),
  kind: z.enum(UTTERANCE_KINDS),
  conceptId: z.string().optional(),
  confidence: z.number().min(0).max(1),
  mood: z.enum(MOODS),
});
export type CadetUtterance = z.infer<typeof CadetUtteranceZ>;
