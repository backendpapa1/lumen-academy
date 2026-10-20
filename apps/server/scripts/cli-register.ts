// pnpm cli:register --school "Blockchain" [--difficulty gentle|standard|ruthless] [--seed 42]
import { ARCHETYPE_INFO } from "@lumen/shared";
import { dirname } from "node:path";
import { findConfigDir, loadConfig } from "../src/config/load.js";
import { dbPath, loadDotEnv } from "../src/config/paths.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { registerClassroom } from "../src/game/registrar.js";
import type { Difficulty } from "../src/game/registration.js";
import { ensureSchool } from "../src/ingest/pipeline.js";
import { ModelFactory } from "../src/models/factory.js";
import { UsageMeter } from "../src/usage/meter.js";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const schoolName = arg("school");
if (!schoolName) {
  console.error(
    'usage: pnpm cli:register --school "<name>" [--difficulty gentle|standard|ruthless] [--seed N]',
  );
  process.exit(2);
}
loadDotEnv(dirname(findConfigDir()));
const cfg = loadConfig();
const handle = openDb(dbPath(cfg));
runMigrations(handle);
const meter = new UsageMeter({ db: handle.db, pricing: cfg.pricing, budget: cfg.models.budget });
const factory = new ModelFactory({ config: cfg.models, env: process.env, meter });
const school = ensureSchool(handle, schoolName);
const before = meter.totals().monthUsd;
const t0 = performance.now();
const res = await registerClassroom(
  { handle, factory, game: cfg.game },
  {
    schoolId: school.id,
    difficulty: (arg("difficulty") as Difficulty | undefined) ?? "standard",
    seed: arg("seed") ? Number(arg("seed")) : undefined,
    onArrival: (c, i, n) =>
      console.log(
        `[${((performance.now() - t0) / 1000).toFixed(1)}s] ${i}/${n} ${c.name} · from ${c.homeworld}\n        ${ARCHETYPE_INFO[c.archetype].label} · "${c.quirk}"`,
      ),
  },
);
console.log(
  `\n${res.name} assembled: ${res.cadets.length} cadets (${res.difficulty}, seed ${res.seed}) · $${(meter.totals().monthUsd - before).toFixed(4)}`,
);
handle.close();
