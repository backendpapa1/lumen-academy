import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import {
  ArtPromptsConfigZ,
  EnvZ,
  GameConfigZ,
  ModelsConfigZ,
  PricingConfigZ,
  type ArtPromptsConfig,
  type Env,
  type GameConfig,
  type ModelsConfig,
  type PricingConfig,
} from "@lumen/shared";

export interface AppConfig {
  models: ModelsConfig;
  pricing: PricingConfig;
  game: GameConfig;
  artPrompts: ArtPromptsConfig;
  env: Env;
  configDir: string;
}

export class ConfigError extends Error {
  constructor(
    readonly file: string,
    readonly issues: string[],
  ) {
    super(`Invalid config in ${file}:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Walks up from `start` to the first directory containing config/models.yaml. */
export function findConfigDir(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, "config");
    if (existsSync(join(candidate, "models.yaml"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`config/models.yaml not found above ${start}`);
    dir = parent;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

function loadYaml<T>(configDir: string, file: string, schema: z.ZodType<T>): T {
  const path = join(configDir, file);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(file, [(err as Error).message]);
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw new ConfigError(file, formatIssues(result.error));
  return result.data;
}

export function loadConfig(opts: { configDir?: string; env?: NodeJS.ProcessEnv } = {}): AppConfig {
  const configDir = opts.configDir ?? findConfigDir();
  const envResult = EnvZ.safeParse(opts.env ?? process.env);
  if (!envResult.success) throw new ConfigError("environment", formatIssues(envResult.error));
  const env = envResult.data;

  const models = loadYaml(configDir, "models.yaml", ModelsConfigZ);
  if (env.LUMEN_PROFILE) {
    if (!models.profiles[env.LUMEN_PROFILE]) {
      throw new ConfigError("environment", [
        `LUMEN_PROFILE: "${env.LUMEN_PROFILE}" is not a profile in models.yaml (have: ${Object.keys(models.profiles).join(", ")})`,
      ]);
    }
    models.profile = env.LUMEN_PROFILE;
  }

  return {
    models,
    pricing: loadYaml(configDir, "pricing.yaml", PricingConfigZ),
    game: loadYaml(configDir, "game.yaml", GameConfigZ),
    artPrompts: loadYaml(configDir, "art-prompts.yaml", ArtPromptsConfigZ),
    env,
    configDir,
  };
}
