// pnpm images:probe — what the configured image model supports (docs/07 §3.1).
// Two low-quality calls (~$0.01), metered; the answer is cached in settings.
import { dirname } from "node:path";
import { OpenAIImages } from "../src/assets/images.js";
import { probeImageModel, saveProbe } from "../src/assets/probe.js";
import { findConfigDir, loadConfig } from "../src/config/load.js";
import { dbPath, loadDotEnv } from "../src/config/paths.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { UsageMeter } from "../src/usage/meter.js";

loadDotEnv(dirname(findConfigDir()));
const cfg = loadConfig();
const handle = openDb(dbPath(cfg));
runMigrations(handle);
const meter = new UsageMeter({ db: handle.db, pricing: cfg.pricing, budget: cfg.models.budget });
const gen = new OpenAIImages({ config: cfg.models, env: process.env, meter });
console.log(`Probing ${gen.model}…`);
const before = meter.totals().dayUsd;
const probe = await probeImageModel(gen);
saveProbe(handle, probe);
console.log(JSON.stringify(probe, null, 2));
console.log(`cost ≈ $${(meter.totals().dayUsd - before).toFixed(4)}`);
handle.close();
