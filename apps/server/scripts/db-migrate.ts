import { findConfigDir, loadConfig } from "../src/config/load.js";
import { dbPath, loadDotEnv } from "../src/config/paths.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { dirname } from "node:path";

loadDotEnv(dirname(findConfigDir()));
const cfg = loadConfig();
const path = dbPath(cfg);
const handle = openDb(path);
runMigrations(handle);
const tables = handle.sqlite
  .prepare(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  )
  .get() as { n: number };
handle.close();
console.log(`migrated ${path} (${tables.n} tables incl. virtual/shadow)`);
