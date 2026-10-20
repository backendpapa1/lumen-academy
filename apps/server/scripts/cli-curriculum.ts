// pnpm cli:curriculum --school "Blockchain"   — runs the Curriculum Architect (C-1) and saves it.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildCurriculum } from "../src/agents/deep/curriculumArchitect.js";
import { findConfigDir, loadConfig } from "../src/config/load.js";
import { dbPath, loadDotEnv } from "../src/config/paths.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { saveCurriculum } from "../src/db/curriculum.js";
import {
  CurriculumEditError,
  exportCurriculumYaml,
  importCurriculumYaml,
} from "../src/db/curriculumEdit.js";
import { OpenAIEmbedder } from "../src/ingest/embed.js";
import { ensureSchool } from "../src/ingest/pipeline.js";
import { ModelFactory } from "../src/models/factory.js";
import { UsageMeter } from "../src/usage/meter.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const schoolName = arg("school");
const exportPath = arg("export");
const importPath = arg("import");
if (!schoolName) {
  console.error(
    'usage: pnpm cli:curriculum --school "<name>" [--export file.yaml | --import file.yaml]',
  );
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
const userPath = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);

if (exportPath) {
  writeFileSync(userPath(exportPath), exportCurriculumYaml(handle, school.id));
  console.log(`Exported to ${userPath(exportPath)}. Edit it, then run with --import.`);
  process.exit(0);
}
if (importPath) {
  try {
    const s = importCurriculumYaml(handle, school.id, readFileSync(userPath(importPath), "utf8"));
    console.log(
      `Imported: ${s.updated} updated, ${s.added} added, ${s.deleted} deleted concepts; ${s.modulesAdded} modules added, ${s.modulesDeleted} deleted.`,
    );
    process.exit(0);
  } catch (err) {
    if (err instanceof CurriculumEditError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

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
