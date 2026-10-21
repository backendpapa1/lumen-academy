import { z } from "zod";
import type { AppConfig } from "./config/load.js";
import type { DbHandle } from "./db/client.js";

// User settings (O-1, docs/05 §6 PUT /api/settings): persisted in the settings
// table and applied by updating the live config objects in place, so the model
// factory, meter and sessions see changes without a restart.

export const UserSettingsZ = z.strictObject({
  profile: z.string().min(1),
  monthlyUsdCap: z.number().min(1).max(500),
  imagesUsdCap: z.number().min(0).max(500),
  periodMinutes: z.number().int(),
});
export type UserSettings = z.infer<typeof UserSettingsZ>;

const KEY = "user";

export function currentSettings(cfg: AppConfig): UserSettings {
  return {
    profile: cfg.models.profile,
    monthlyUsdCap: cfg.models.budget.monthlyUsdCap,
    imagesUsdCap: cfg.models.budget.imagesUsdCap,
    periodMinutes: cfg.game.period.defaultMinutes,
  };
}

/** Validates against this config (known profile, period bounds); returns problems in plain words. */
export function checkSettings(cfg: AppConfig, s: UserSettings): string[] {
  const problems: string[] = [];
  if (!(s.profile in cfg.models.profiles))
    problems.push(`There's no model profile called "${s.profile}".`);
  const { minMinutes, maxMinutes } = cfg.game.period;
  if (s.periodMinutes < minMinutes || s.periodMinutes > maxMinutes)
    problems.push(`A class period is ${minMinutes}–${maxMinutes} minutes.`);
  if (s.imagesUsdCap > s.monthlyUsdCap)
    problems.push("The image budget can't be more than the monthly budget.");
  return problems;
}

export function applySettings(cfg: AppConfig, s: UserSettings): void {
  cfg.models.profile = s.profile;
  cfg.models.budget.monthlyUsdCap = s.monthlyUsdCap;
  cfg.models.budget.imagesUsdCap = s.imagesUsdCap;
  cfg.game.period.defaultMinutes = s.periodMinutes;
}

/** At startup: saved settings win over the YAML defaults (LUMEN_PROFILE still wins for the profile). */
export function loadSavedSettings(handle: DbHandle, cfg: AppConfig): void {
  const row = handle.sqlite.prepare("SELECT value_json FROM settings WHERE key = ?").get(KEY) as
    { value_json: string } | undefined;
  if (!row) return;
  const parsed = UserSettingsZ.safeParse(JSON.parse(row.value_json));
  if (!parsed.success || checkSettings(cfg, parsed.data).length) return;
  applySettings(cfg, { ...parsed.data, profile: cfg.env.LUMEN_PROFILE ?? parsed.data.profile });
}

export function saveSettings(handle: DbHandle, s: UserSettings): void {
  handle.sqlite
    .prepare(
      "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(KEY, JSON.stringify(s));
}
