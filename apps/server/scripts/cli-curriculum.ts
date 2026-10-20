// pnpm cli:curriculum --school "Blockchain"   — runs the Curriculum Architect (C-1) and saves it.
import { dirname } from "node:path";
import { buildCurriculum } from "../src/agents/deep/curriculumArchitect.js";
import { findConfigDir, loadConfig } from "../src/config/load.js";
import { dbPath, loadDotEnv } from "../src/config/paths.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { saveCurriculum } from "../src/db/curriculum.js";
import { OpenAIEmbedder } from "../src/ingest/embed.js";
import { ensureSchool } from "../src/ingest/pipeline.js";
import { ModelFactory } from "../src/models/factory.js";
import { UsageMeter } from "../src/usage/meter.js";

const i = process.argv.indexOf("--school");
const schoolName = i >= 0 ? process.argv[i + 1] : undefined;
if (!schoolName) {
  console.error('usage: pnpm cli:curriculum --school "<name>"');
  process.exit(2);
}
loadDotEnv(dirname(findConfigDir()));
const cfg = loadConfig();
const handle = openDb(dbPath(cfg));
runMigrations(handle);
const meter = new UsageMeter({ db: handle.db, pricing: cfg.pricing, budget: cfg.models.budget });
const factory = new ModelFactory({ config: cfg.models, env: process.env, meter });
const embedder = new OpenAIEmbedder({ config: cfg.models, env: process.env, meter });
const school = ensureSchool(handle, schoolName);

const before = meter.totals().monthUsd;
const started = performance.now();
console.log(`Building curriculum for "${schoolName}"…`);
const result = await buildCurriculum({ factory, handle, embedder }, school.id);
const saved = saveCurriculum(handle, school.id, result.curriculum);
for (const [mi, m] of result.curriculum.modules.entries()) {
  console.log(`\n${mi + 1}. ${m.title}: ${m.goal}`);
  for (const c of m.concepts)
    console.log(
      `   - ${c.title} (d${c.difficulty}, ${c.keyFacts.length} facts, ${c.misconceptions.length} misconceptions, ${c.citations.length} cites)`,
    );
}
for (const [n, problems] of result.rejections.entries()) {
  console.log(`\nAttempt ${n + 1} was rejected:\n- ${problems.join("\n- ")}`);
}
if (result.warnings.length) console.log(`\nWarnings:\n- ${result.warnings.join("\n- ")}`);
console.log(
  `\nSaved ${saved.modules} modules / ${saved.concepts} concepts · attempts ${result.attempts} · ${((performance.now() - started) / 1000).toFixed(0)}s · $${(meter.totals().monthUsd - before).toFixed(4)}`,
);
handle.close();
