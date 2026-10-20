// pnpm models:check — verifies every configured model id exists, every text role
// answers a structured-output call, and embeddings have the expected dimensions.
// Exits non-zero on any failure. Costs a few cents at most; usage is metered.
import { dirname } from "node:path";
import { findConfigDir, loadConfig } from "../src/config/load.js";
import { dbPath, loadDotEnv } from "../src/config/paths.js";
import { openDb, runMigrations } from "../src/db/client.js";
import {
  checkEmbeddings,
  checkModelIds,
  checkRoles,
  probeDeepSeekThinkingToolLoop,
  type CheckLine,
} from "../src/models/check.js";
import { ModelFactory } from "../src/models/factory.js";
import { UsageMeter } from "../src/usage/meter.js";

loadDotEnv(dirname(findConfigDir()));
const cfg = loadConfig();
const env = process.env;

const print = (title: string, lines: CheckLine[]) => {
  console.log(`\n${title}`);
  for (const l of lines)
    console.log(`  ${l.info ? "ℹ" : l.ok ? "✓" : "✗"} ${l.label}: ${l.detail}`);
};

console.log(`Lumen models:check · profile ${cfg.models.profile}`);

const idLines = await checkModelIds(cfg.models, env);
print("1. Model ids (all profiles + fallbacks)", idLines);

const all: CheckLine[] = [...idLines];
if (idLines.every((l) => l.ok)) {
  const handle = openDb(dbPath(cfg));
  runMigrations(handle);
  const meter = new UsageMeter({ db: handle.db, pricing: cfg.pricing, budget: cfg.models.budget });
  const factory = new ModelFactory({ config: cfg.models, env, meter });

  const roleLines = await checkRoles(factory);
  print(`2. Text roles (${cfg.models.profile})`, roleLines);
  const emb = await checkEmbeddings(cfg.models, env);
  print("3. Embeddings", [emb]);
  const probe = await probeDeepSeekThinkingToolLoop(cfg.models, env);
  print("4. DeepSeek thinking + tool loop", [probe]);
  all.push(...roleLines, emb, probe);

  const t = meter.totals();
  console.log(
    `\nCost of this check: logged to usage_log · month to date $${t.monthUsd.toFixed(4)}${t.unpricedCalls ? ` (+${t.unpricedCalls} unpriced calls: fill config/pricing.yaml)` : ""}`,
  );
  handle.close();
} else {
  console.log("\nSkipping live calls until every model id is valid.");
}

const failed = all.filter((l) => !l.ok);
console.log(
  failed.length ? `\nFAILED: ${failed.length} problem(s).` : "\nAll configured models OK.",
);
process.exit(failed.length ? 1 : 0);
