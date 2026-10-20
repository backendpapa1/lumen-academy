import { dirname } from "node:path";
import { buildApp } from "./app.js";
import { findConfigDir, loadConfig } from "./config/load.js";
import { dbPath, loadDotEnv } from "./config/paths.js";
import { openDb, runMigrations } from "./db/client.js";
import { OpenAIEmbedder } from "./ingest/embed.js";
import { ModelFactory } from "./models/factory.js";
import { UsageMeter } from "./usage/meter.js";

// Local-only: never bind beyond loopback (CLAUDE.md hard rule).
const HOST = "127.0.0.1";

loadDotEnv(dirname(findConfigDir()));
const config = loadConfig();
const handle = openDb(dbPath(config));
runMigrations(handle);
const meter = new UsageMeter({
  db: handle.db,
  pricing: config.pricing,
  budget: config.models.budget,
});
const factory = new ModelFactory({ config: config.models, env: process.env, meter });
const embedder = new OpenAIEmbedder({ config: config.models, env: process.env, meter });

const app = await buildApp({
  config,
  logger: true,
  runtime: { handle, factory, meter, embedder, game: config.game },
});
await app.listen({ host: HOST, port: config.env.LUMEN_PORT });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(
    signal,
    () =>
      void app.close().then(() => {
        handle.close();
        process.exit(0);
      }),
  );
}
