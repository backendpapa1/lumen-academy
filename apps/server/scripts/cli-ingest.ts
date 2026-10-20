// pnpm cli:ingest --school "Blockchain" <file> [--title "Chapter 11"]
// Creates the School if needed (S-1) and indexes one source (S-2, S-3).
import { readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { findConfigDir, loadConfig } from "../src/config/load.js";
import { dataDir, dbPath, loadDotEnv } from "../src/config/paths.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { OpenAIEmbedder } from "../src/ingest/embed.js";
import type { SourceKind } from "../src/ingest/parse.js";
import { ensureSchool, ingestSource } from "../src/ingest/pipeline.js";
import { UsageMeter } from "../src/usage/meter.js";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const schoolName = opt("school");
const title = opt("title");
const file = args[0];
const KINDS: Record<string, SourceKind> = {
  ".pdf": "pdf",
  ".md": "md",
  ".markdown": "md",
  ".txt": "txt",
};
const kind = file ? KINDS[extname(file).toLowerCase()] : undefined;
if (!schoolName || !file || !kind) {
  console.error('usage: pnpm cli:ingest --school "<name>" <file.pdf|.md|.txt> [--title "<title>"]');
  process.exit(2);
}

const root = dirname(findConfigDir());
loadDotEnv(root);
const cfg = loadConfig();
const handle = openDb(dbPath(cfg));
runMigrations(handle);
const meter = new UsageMeter({ db: handle.db, pricing: cfg.pricing, budget: cfg.models.budget });
const embedder = new OpenAIEmbedder({ config: cfg.models, env: process.env, meter });

const school = ensureSchool(handle, schoolName);
console.log(`${school.created ? "Created" : "Using"} school "${schoolName}" (${school.id})`);
const before = meter.totals().monthUsd;
const started = performance.now();
const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
const result = await ingestSource(
  {
    handle,
    embedder,
    dataDir: dataDir(cfg),
    onStatus: (s, d) => console.log(`  ${s}${d ? `: ${d}` : ""}`),
  },
  {
    schoolId: school.id,
    title: title ?? basename(file, extname(file)),
    kind,
    data: kind === "pdf" ? new Uint8Array(readFileSync(path)) : readFileSync(path, "utf8"),
  },
);
console.log(
  `Indexed ${result.chunks} chunks (~${result.tokens} tokens${result.pageCount ? `, ${result.pageCount} pages` : ""}) as ${result.sourceId} in ${((performance.now() - started) / 1000).toFixed(1)}s · cost $${(meter.totals().monthUsd - before).toFixed(5)}`,
);
handle.close();
