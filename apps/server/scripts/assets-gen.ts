// pnpm assets:gen [--dry-run] [--only <group|id>] [--quality draft] [--force] [--preview]
// Generates the static art in apps/client/src/assets/manifest.json (docs/07 §4–5).
// Every call goes through the budget guard and the usage meter.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { OpenAIImages } from "../src/assets/images.js";
import {
  contactSheet,
  estimate,
  generate,
  ManifestZ,
  plan,
  readLock,
} from "../src/assets/staticGen.js";
import { findConfigDir, loadConfig } from "../src/config/load.js";
import { dbPath, loadDotEnv, repoRoot } from "../src/config/paths.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { UsageMeter } from "../src/usage/meter.js";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean" },
    only: { type: "string" },
    quality: { type: "string" },
    force: { type: "boolean" },
    preview: { type: "boolean" },
  },
});
loadDotEnv(dirname(findConfigDir()));
const cfg = loadConfig();
const root = join(repoRoot(cfg), "apps/client/src/assets");
const manifest = ManifestZ.parse(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")));
const lockPath = join(root, "generated/.lock.json");
const sheet = join(root, "generated/contact-sheet.html");

if (values.preview) {
  console.log(`Contact sheet: ${contactSheet(manifest, root, sheet)}`);
  process.exit(0);
}

const handle = openDb(dbPath(cfg));
runMigrations(handle);
const meter = new UsageMeter({ db: handle.db, pricing: cfg.pricing, budget: cfg.models.budget });
const gen = new OpenAIImages({ config: cfg.models, env: process.env, meter });
const lock = readLock(lockPath);
const todo = plan(manifest, cfg.artPrompts, gen.model, root, lock, {
  only: values.only,
  force: values.force,
  quality: values.quality === "draft" ? "draft" : undefined,
});
const est = estimate(cfg.pricing, gen.model, todo);
console.log(
  `${todo.length} of ${manifest.assets.length} assets to generate with ${gen.model} · est. ${est == null ? "≈?" : `$${est.toFixed(3)}`}`,
);
for (const p of todo)
  console.log(`  ${p.reason.padEnd(8)} ${p.asset.id.padEnd(24)} ${p.asset.size} ${p.quality}`);
if (values["dry-run"] || !todo.length) process.exit(0);
console.log(`Image budget left this month: $${meter.imageBudgetLeft().toFixed(2)}`);

const before = meter.totals().dayUsd;
let done = 0;
let failed = 0;
// Two at a time (docs/07 §3), saving the lock after each so a stop loses nothing.
const queue = [...todo];
await Promise.all(
  [0, 1].map(async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        await generate(gen, root, p);
        lock[p.asset.id] = p.hash;
        writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
        console.log(`  ✓ ${p.asset.id} (${++done}/${todo.length})`);
      } catch (err) {
        failed++;
        console.log(`  ✗ ${p.asset.id}: ${(err as Error).message}`);
      }
    }
  }),
);
contactSheet(manifest, root, sheet);
console.log(
  `Done: ${done} generated, ${failed} failed · spent ≈ $${(meter.totals().dayUsd - before).toFixed(3)} · ${sheet}`,
);
handle.close();
if (failed) process.exitCode = 1;
