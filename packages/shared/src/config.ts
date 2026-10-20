import { z } from "zod";

// Config schemas for config/*.yaml. Loading lives in apps/server/src/config.

export const ProviderZ = z.enum(["openai", "deepseek"]);
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
  })
  .refine((b) => b.softWarnAt <= b.degradeAt, "softWarnAt must be <= degradeAt");

export const ModelsConfigZ = z
  .strictObject({
    profile: ProfileNameZ,
    providers: z.strictObject({ openai: ProviderConfigZ, deepseek: ProviderConfigZ }),
    profiles: z.record(ProfileNameZ, ProfileZ),
    fallbacks: z.strictObject({
      fastest: z.array(FallbackIdZ).min(1),
      fast: z.array(FallbackIdZ).min(1),
      standard: z.array(FallbackIdZ).min(1),
      heavy: z.array(FallbackIdZ).min(1),
    }),
    agents: z.record(AgentNameZ, AgentOverrideZ), // zod 4: enum-keyed records require every key
    budget: BudgetZ,
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
});
export type PricingConfig = z.infer<typeof PricingConfigZ>;

// ------------------------------------------------------------------- game.yaml

const unit = z.number().min(0).max(1);

export const GameConfigZ = z.strictObject({
  period: z.strictObject({
    defaultMinutes: z.number().int().min(5).max(45),
    minMinutes: z.number().int().positive(),
    maxMinutes: z.number().int().positive(),
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
  buildingTiers: z.array(unit).length(3), // mastered fraction for tiers 2, 3, 4
  xp: z.record(z.string(), z.number()),
  ranks: z.array(z.strictObject({ name: z.string(), minXp: z.number().int().nonnegative() })),
  events: z.strictObject({ enabled: z.boolean(), maxPerPeriod: z.number().int().nonnegative() }),
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
