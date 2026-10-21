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
import { castVoices } from "./game/voiceCast.js";
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
// No OpenAI key yet (a fresh desktop install): the app still starts, and indexing
// waits until the key is added in the configurator.
const embedder = process.env[config.models.providers.openai.apiKeyEnv]
  ? new OpenAIEmbedder({ config: config.models, env: process.env, meter })
  : undefined;
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
// Older students get a voice that fits their name (one small call, once).
void castVoices({ handle, factory }, (m) => app.log.warn(m)).then(
  (n) => n && app.log.info(`cast voices for ${n} students`),
);

// However we exit, the speech sidecar (whisper-server) goes too.
process.on("exit", () => speech?.stt.close());

// The desktop app (ADR-011): if the window process goes away without stopping
// us (killed, crashed), stop too, so no server is left holding the database.
if (process.env.LUMEN_DESKTOP) {
  const parent = process.ppid;
  let leaving = false;
  setInterval(() => {
    let alive = process.ppid === parent;
    try {
      process.kill(parent, 0);
    } catch {
      alive = false;
    }
    if (alive || leaving) return;
    leaving = true;
    // A graceful close can wait on open sockets or the speech sidecars; don't let it.
    setTimeout(() => process.exit(0), 1500);
    void app.close().finally(() => {
      handle.close();
      process.exit(0);
    });
  }, 2000).unref();
}

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
