import { z } from "zod";

// Config schemas for config/*.yaml. Loading lives in apps/server/src/config.

// "local": an OpenAI-compatible server on this machine (llama.cpp), for practice mode (VD12).
export const ProviderZ = z.enum(["openai", "deepseek", "local"]);
export type Provider = z.infer<typeof ProviderZ>;

// Profiles are named in models.yaml; `profile` must name one of them (ADR-007).
export const ProfileNameZ = z.string().min(1);
export type ProfileName = z.infer<typeof ProfileNameZ>;

export const TEXT_ROLES = ["fastest", "fast", "standard", "heavy"] as const;
export const TextRoleZ = z.enum(TEXT_ROLES);
export type TextRole = z.infer<typeof TextRoleZ>;

export const RoleZ = z.enum([...TEXT_ROLES, "embeddings", "image"]);
export type Role = z.infer<typeof RoleZ>;

export const AGENT_NAMES = [
  "crowdReactor",
  "classDirector",
  "cadetTalk",
  "cadetHomework",
  "notesRewriter",
  "leakGuard",
  "registrar",
  "curriculumArchitect",
  "examiner",
  "grader",
  "dean",
  "debriefAnalyst",
  "recapWriter",
  "yearbookEditor",
  "alumniPinger",
  "artDirector",
  "transcriptFixer",
  "knowledgeReporter",
] as const;
export const AgentNameZ = z.enum(AGENT_NAMES);
export type AgentName = z.infer<typeof AgentNameZ>;

export const ReasoningEffortZ = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const DEEPSEEK_EFFORTS = ["low", "high", "max"];

export const ModelSpecZ = z
  .strictObject({
    provider: ProviderZ,
    model: z.string().min(1),
    thinking: z.enum(["on", "off"]).optional(), // DeepSeek only (ADR-004)
    // OpenAI: any effort. DeepSeek: low | high | max, thinking on only (ADR-007).
    reasoningEffort: ReasoningEffortZ.optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    /** Overrides the provider timeout; long thinking calls need minutes, realtime ones seconds. */
    timeoutMs: z.number().int().positive().optional(),
  })
  .superRefine((s, ctx) => {
    if (s.provider !== "deepseek" || s.reasoningEffort === undefined) return;
    if (!DEEPSEEK_EFFORTS.includes(s.reasoningEffort)) {
      ctx.addIssue({
        code: "custom",
        path: ["reasoningEffort"],
        message: `DeepSeek supports ${DEEPSEEK_EFFORTS.join(" | ")}`,
      });
    }
    if (s.thinking !== "on") {
      ctx.addIssue({
        code: "custom",
        path: ["reasoningEffort"],
        message: "DeepSeek reasoningEffort needs thinking: on",
      });
    }
  });
export type ModelSpec = z.infer<typeof ModelSpecZ>;

export const ProfileZ = z.strictObject({
  fastest: ModelSpecZ,
  fast: ModelSpecZ,
  standard: ModelSpecZ,
  heavy: ModelSpecZ,
  embeddings: ModelSpecZ,
  image: ModelSpecZ,
});

/** "provider:model", e.g. "deepseek:deepseek-flash". */
export const FallbackIdZ = z
  .string()
  .regex(/^(openai|deepseek):[\w.-]+$/, 'must look like "openai:<model>" or "deepseek:<model>"');

export const AgentOverrideZ = z.strictObject({
  role: TextRoleZ,
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  sampleRate: z.number().min(0).max(1).optional(),
});

export const ProviderConfigZ = z.strictObject({
  apiKeyEnv: z.string().min(1),
  baseURL: z.url(),
  timeoutMs: z.number().int().positive(),
});

export const BudgetZ = z
  .strictObject({
    monthlyUsdCap: z.number().positive(),
    softWarnAt: z.number().gt(0).lt(1), // fraction of cap → toast
    degradeAt: z.number().gt(0).max(1), // fraction of cap → all roles to fastest
    onCap: z.enum(["degrade_then_pause", "pause"]), // at 100% of cap agents pause
    /** Image spend allowed inside the monthly cap (docs/07 §6). */
    imagesUsdCap: z.number().nonnegative().default(5),
  })
  .refine((b) => b.softWarnAt <= b.degradeAt, "softWarnAt must be <= degradeAt");

/** V1 voice (VD1–VD4): local speech-to-text and text-to-speech, never in the cloud by default. */
export const SpeechConfigZ = z.strictObject({
  stt: z.strictObject({
    engine: z.literal("whispercpp"),
    /** Paths are per machine: env vars override these defaults (~ expands to $HOME). */
    binary: z.string().min(1),
    model: z.string().min(1),
    port: z.number().int().positive(),
    threads: z.number().int().positive().default(4),
    /** Whisper's initial prompt is built from the School's terms, up to this many characters. */
    glossaryChars: z.number().int().positive().default(600),
    timeoutMs: z.number().int().positive().default(20000),
    /** Whisper's language; multilingual models guess otherwise. */
    language: z.string().min(2).default("en"),
    /** Fix clear mishearings with the School's glossary (DeepSeek, budget-guarded). */
    correct: z.boolean().default(true),
  }),
  tts: z.strictObject({
    engine: z.literal("kokoro"),
    model: z.string().min(1),
    dtype: z.enum(["fp32", "fp16", "q8", "q4"]),
    cacheDir: z.string().min(1),
    /** Voices by register; a student keeps theirs for good (stored on first use). */
    voices: z.strictObject({
      female: z.array(z.string()).min(1),
      male: z.array(z.string()).min(1),
    }),
    /** Speaking rate per archetype (1 = normal). */
    speed: z.record(z.string(), z.number().min(0.5).max(2)),
    /** The first chunk ends at the first comma or after this many words (V1-S2). */
    firstChunkWords: z.number().int().min(2).default(6),
  }),
});
export type SpeechConfig = z.infer<typeof SpeechConfigZ>;

export const ModelsConfigZ = z
  .strictObject({
    profile: ProfileNameZ,
    providers: z.strictObject({
      openai: ProviderConfigZ,
      deepseek: ProviderConfigZ,
      local: ProviderConfigZ.optional(),
    }),
    profiles: z.record(ProfileNameZ, ProfileZ),
    fallbacks: z.strictObject({
      fastest: z.array(FallbackIdZ).min(1),
      fast: z.array(FallbackIdZ).min(1),
      standard: z.array(FallbackIdZ).min(1),
      heavy: z.array(FallbackIdZ).min(1),
    }),
    agents: z.record(AgentNameZ, AgentOverrideZ), // zod 4: enum-keyed records require every key
    budget: BudgetZ,
    speech: SpeechConfigZ.optional(),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.profiles[cfg.profile]) {
      ctx.addIssue({
        code: "custom",
        path: ["profile"],
        message: `profile "${cfg.profile}" is not defined under profiles (have: ${Object.keys(cfg.profiles).join(", ") || "none"})`,
      });
    }
    for (const [profileName, profile] of Object.entries(cfg.profiles)) {
      for (const role of ["embeddings", "image"] as const) {
        if (profile[role].provider !== "openai") {
          ctx.addIssue({
            code: "custom",
            path: ["profiles", profileName, role, "provider"],
            message: `${role} must use openai (docs/04 §1)`,
          });
        }
      }
    }
  });
export type ModelsConfig = z.infer<typeof ModelsConfigZ>;

/** The active profile. The schema guarantees it exists. */
export function activeProfile(cfg: ModelsConfig): z.infer<typeof ProfileZ> {
  const profile = cfg.profiles[cfg.profile];
  if (!profile) throw new Error(`profile "${cfg.profile}" is not defined in models.yaml`);
  return profile;
}

// ---------------------------------------------------------------- pricing.yaml

const usd = z.number().nonnegative().nullable();

export const TokenPriceZ = z.strictObject({
  input: usd,
  cachedInput: usd.optional(),
  output: usd.optional(),
});

export const ImagePriceZ = z.strictObject({
  perImage: z.strictObject({ low: usd, medium: usd, high: usd }),
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM");

export const TimeOfDayZ = z.strictObject({
  tz: z.string().min(1),
  peak: z.array(z.tuple([hhmm, hhmm])),
  /** Peak windows apply Mon–Fri only (in `tz`). */
  weekdaysOnly: z.boolean().default(false),
  peakMultiplier: z.number().positive(),
});

export const ProviderPricingZ = z.strictObject({
  models: z.record(z.string(), z.union([TokenPriceZ, ImagePriceZ])),
  timeOfDay: TimeOfDayZ.optional(),
});

export const PricingConfigZ = z.strictObject({
  openai: ProviderPricingZ,
  deepseek: ProviderPricingZ,
  local: ProviderPricingZ.optional(),
});
export type PricingConfig = z.infer<typeof PricingConfigZ>;

// ------------------------------------------------------------------- game.yaml

// Mirrors ARCHETYPES in agents.ts (kept here to avoid a config → agents import cycle).
const ARCHETYPE_KEYS = [
  "skeptic",
  "lost_signal",
  "overachiever",
  "literalist",
  "pragmatist",
  "connector",
  "quiet",
  "saboteur",
] as const;

const unit = z.number().min(0).max(1);

export const GameConfigZ = z.strictObject({
  period: z.strictObject({
    defaultMinutes: z.number().int().min(5).max(45),
    minMinutes: z.number().int().positive(),
    maxMinutes: z.number().int().positive(),
    /** An unfinished period is picked back up if it was last active this recently; older ones are closed. */
    resumeWithinHours: z.number().positive(),
  }),
  cohort: z
    .strictObject({
      min: z.number().int().positive(),
      mode: z.number().int().positive(),
      max: z.number().int().positive(),
    })
    .refine((c) => c.min <= c.mode && c.mode <= c.max, "cohort must satisfy min <= mode <= max"),
  classroomsPerSchool: z.number().int().positive(),
  cadet: z.strictObject({ maxWords: z.number().int().positive() }),
  comprehension: z.strictObject({
    base: z.number().positive(),
    styleBonus: z.number().nonnegative(),
    directorAdjustBound: z.number().nonnegative(),
    deltaMin: z.number().max(0),
    deltaMax: z.number().min(0),
    misconceptionAdoption: unit,
    lowConfidenceWeight: unit,
    understoodAt: unit,
  }),
  /** V2 forgetting (VD5): recall decays toward a floor; spaced reviews slow it. */
  memory: z
    .strictObject({
      /** Half-life of a freshly taught concept, in days. */
      halfLifeDays: z.number().positive(),
      /** Each spaced review multiplies the half-life by this. */
      growth: z.number().min(1),
      maxHalfLifeDays: z.number().positive(),
      /** Recall never drops below this share of what was understood. */
      floor: unit,
      /** A review only counts as spaced if it's at least this long after the last one. */
      spacedAfterHours: z.number().nonnegative(),
      /** Below this share of its strength, a concept is "fading" (the lobby offers a refresher). */
      fadingAt: unit,
    })
    .default({
      halfLifeDays: 2,
      growth: 1.8,
      maxHalfLifeDays: 90,
      floor: 0.35,
      spacedAfterHours: 12,
      fadingAt: 0.75,
    }),
  /** V2-05 mistake journal: spaced re-checks of things I got wrong. */
  mistakes: z
    .strictObject({
      /** Days until the next re-check after 0, 1, … right answers. */
      intervalsDays: z.array(z.number().positive()).min(1),
      /** Right answers that settle a mistake. */
      settleAfter: z.number().int().min(1),
      /** No re-check before this teaching turn (let the class warm up). */
      fromTurn: z.number().int().min(1),
      /** Grader score (1–5) that counts as right. */
      passScore: z.number().min(1).max(5),
    })
    .default({ intervalsDays: [1, 3, 7], settleAfter: 2, fromTurn: 2, passScore: 3 }),
  registration: z.strictObject({
    batchSize: z.number().int().min(1).max(15),
    /** Generated portrait images per student. Off since students are drawn (ADR-009). */
    portraits: z.boolean().default(false),
    guaranteed: z.array(
      z.strictObject({ archetype: z.enum(ARCHETYPE_KEYS), minSize: z.number().int().min(1) }),
    ),
    weights: z.strictObject({
      standard: z.partialRecord(z.enum(ARCHETYPE_KEYS), z.number().nonnegative()),
      gentle: z.partialRecord(z.enum(ARCHETYPE_KEYS), z.number().nonnegative()),
      ruthless: z.partialRecord(z.enum(ARCHETYPE_KEYS), z.number().nonnegative()),
    }),
    homeworlds: z.array(z.string().min(1)).min(1),
    heritage: z.array(z.string().min(1)).min(1),
    genderPresentation: z.array(z.string().min(1)).min(1),
    ageRange: z.array(z.string().min(1)).min(1),
  }),
  traitSpread: unit,
  archetypes: z.record(
    z.enum(ARCHETYPE_KEYS),
    z.strictObject({
      attention: unit,
      skepticism: unit,
      curiosity: unit,
      verbosity: unit,
      confidence: unit,
      humor: unit,
    }),
  ),
  fatigue: z.strictObject({
    onsetMinute: z.number().nonnegative(),
    perMinute: z.number().nonnegative(),
    floor: unit,
  }),
  status: z.strictObject({
    weakScore: unit,
    weakComprehension: unit,
    weakMinExposures: z.number().int().nonnegative(),
    masteredScore: unit,
    masteredComprehension: unit,
  }),
  exam: z.strictObject({ passThreshold: unit, unlockTaughtFraction: unit }),
  streak: z.strictObject({
    timezone: z.string().min(1),
    /** V3-07: every this many streak days earns a freeze, which covers one missed day. */
    freezeEveryDays: z.number().int().positive().default(7),
    maxFreezes: z.number().int().nonnegative().default(2),
  }),
  /** V3-01: one idea, one student, one question. XP is a flat xp.microLesson, not per minute. */
  micro: z.strictObject({ minutes: z.number().int().min(1).max(10) }).default({ minutes: 3 }),
  buildingTiers: z.array(unit).length(3), // mastered fraction for tiers 2, 3, 4
  xp: z.record(z.string(), z.number()),
  ranks: z.array(z.strictObject({ name: z.string(), minXp: z.number().int().nonnegative() })),
  events: z.strictObject({
    enabled: z.boolean(),
    maxPerPeriod: z.number().int().nonnegative(),
    earliestTurn: z.number().int().positive(),
    latestTurn: z.number().int().positive(),
    kinds: z.array(z.enum(["pop_quiz", "glitch", "power_flicker", "inspector"])),
  }),
  leakGuard: z.strictObject({ enabled: z.boolean(), untaughtTermThreshold: z.number().int() }),
  hands: z.strictObject({
    autoPick: z.boolean(),
    idleSeconds: z.number().positive(),
    maxPerTurn: z.number().int().min(0).max(3),
  }),
});
export type GameConfig = z.infer<typeof GameConfigZ>;

// ------------------------------------------------------------ art-prompts.yaml

export const ArtPromptsConfigZ = z.strictObject({
  style: z.record(z.string(), z.string()).refine((s) => "global" in s, "style.global is required"),
  constraints: z.record(z.string(), z.string()),
  templates: z.strictObject({ portrait: z.string(), emblem: z.string() }),
  archetypeVisual: z.record(z.string(), z.string()),
});
export type ArtPromptsConfig = z.infer<typeof ArtPromptsConfigZ>;

// ------------------------------------------------------------------------- env

export const EnvZ = z.object({
  OPENAI_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  LUMEN_PROFILE: ProfileNameZ.optional(),
  LUMEN_PORT: z.coerce.number().int().positive().default(5174),
  LUMEN_DATA_DIR: z.string().default("./data"),
});
export type Env = z.infer<typeof EnvZ>;
