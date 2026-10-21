import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AppConfig } from "./load.js";

/** The repo root is the directory that holds config/. */
export const repoRoot = (cfg: Pick<AppConfig, "configDir">) => dirname(cfg.configDir);

/** LUMEN_DATA_DIR is resolved against the repo root, not the process cwd. */
export const dataDir = (cfg: Pick<AppConfig, "configDir" | "env">) =>
  resolve(repoRoot(cfg), cfg.env.LUMEN_DATA_DIR);

export const dbPath = (cfg: Pick<AppConfig, "configDir" | "env">) => join(dataDir(cfg), "lumen.db");

/** Loads <root>/.env into process.env if present (Node ≥ 20.12 built-in). */
export function loadDotEnv(root: string): void {
  const path = join(root, ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}

/** Where a missing API key gets added, in the words of whichever Lumen this is. */
export const keyPlace = () =>
  process.env.LUMEN_DESKTOP ? "in API keys and settings (Lumen's tray menu)" : "in .env";
