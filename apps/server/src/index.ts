import { dirname, join } from "node:path";
import { OpenAIImages } from "./assets/images.js";
import { AssetService } from "./assets/service.js";
import { buildApp } from "./app.js";
import { findConfigDir, loadConfig } from "./config/load.js";
import { activeProfile } from "@lumen/shared";
import { dataDir, dbPath, loadDotEnv } from "./config/paths.js";
import { openDb, runMigrations } from "./db/client.js";
import { loadSavedSettings } from "./settings.js";
import { OpenAIEmbedder } from "./ingest/embed.js";
import { ModelFactory } from "./models/factory.js";
import { UsageMeter } from "./usage/meter.js";
import { WhisperSidecar } from "./speech/stt.js";
import { KokoroSpeaker } from "./speech/tts.js";

// Local-only: never bind beyond loopback (CLAUDE.md hard rule).
const HOST = "127.0.0.1";

loadDotEnv(dirname(findConfigDir()));
const config = loadConfig();
const handle = openDb(dbPath(config));
runMigrations(handle);
loadSavedSettings(handle, config);
const meter = new UsageMeter({
  db: handle.db,
  pricing: config.pricing,
  budget: config.models.budget,
  imageModel: activeProfile(config.models).image.model,
});
const factory = new ModelFactory({ config: config.models, env: process.env, meter });
const embedder = new OpenAIEmbedder({ config: config.models, env: process.env, meter });
const assetsDir = join(dataDir(config), "generated");
// Images need an OpenAI key; without one the game keeps its silhouettes.
const assets = process.env[config.models.providers.openai.apiKeyEnv]
  ? new AssetService({
      handle,
      gen: new OpenAIImages({ config: config.models, env: process.env, meter }),
      art: config.artPrompts,
      pricing: config.pricing,
      dir: assetsDir,
    })
  : undefined;

// V1 voice: both run on this machine; the sidecar and the model load on first use.
const speechCfg = config.models.speech;
const speech = speechCfg
  ? {
      cfg: speechCfg,
      stt: new WhisperSidecar(speechCfg.stt),
      tts: new KokoroSpeaker(speechCfg.tts),
    }
  : undefined;

const app = await buildApp({
  config,
  logger: true,
  assetsDir,
  dataDir: dataDir(config),
  runtime: { handle, factory, meter, embedder, assets, game: config.game, speech },
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
