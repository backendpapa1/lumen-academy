// pnpm eval:retrieval [--school Blockchain] — live embeddings against the
// indexed fixture: each case's section must be in the top 5.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findConfigDir, loadConfig } from "../src/config/load.js";
import { dbPath, loadDotEnv } from "../src/config/paths.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { OpenAIEmbedder } from "../src/ingest/embed.js";
import { ensureSchool } from "../src/ingest/pipeline.js";
import { hybridSearch } from "../src/retrieval/search.js";
import { UsageMeter } from "../src/usage/meter.js";

const root = dirname(findConfigDir());
loadDotEnv(root);
const cfg = loadConfig();
const i = process.argv.indexOf("--school");
const schoolName = i >= 0 ? process.argv[i + 1]! : "Blockchain";
const handle = openDb(dbPath(cfg));
runMigrations(handle);
const meter = new UsageMeter({ db: handle.db, pricing: cfg.pricing, budget: cfg.models.budget });
const embedder = new OpenAIEmbedder({ config: cfg.models, env: process.env, meter });
const school = ensureSchool(handle, schoolName);
const { cases } = JSON.parse(
  readFileSync(join(root, "fixtures/blockchain-ch1/retrieval-cases.json"), "utf8"),
) as { cases: Array<{ query: string; heading: string }> };

let pass = 0;
for (const { query, heading } of cases) {
  const hits = await hybridSearch({ handle, embedder }, { query, schoolId: school.id, k: 5 });
  const rank = hits.findIndex((h) => (h.headingPath ?? "").endsWith(heading));
  if (rank >= 0) pass++;
  console.log(
    `${rank >= 0 ? `✓ #${rank + 1}` : "✗   "} ${query}  →  ${heading}${rank < 0 ? `  (got: ${hits.map((h) => h.headingPath?.split(" > ").at(-1)).join(" | ")})` : ""}`,
  );
}
console.log(`\n${pass}/${cases.length} in top 5`);
handle.close();
process.exit(pass === cases.length ? 0 : 1);
