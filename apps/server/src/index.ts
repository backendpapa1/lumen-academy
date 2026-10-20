import { dirname } from "node:path";
import { buildApp } from "./app.js";
import { findConfigDir, loadConfig } from "./config/load.js";
import { loadDotEnv } from "./config/paths.js";

// Local-only: never bind beyond loopback (CLAUDE.md hard rule).
const HOST = "127.0.0.1";

loadDotEnv(dirname(findConfigDir()));
const config = loadConfig();
const app = await buildApp({ config, logger: true });
await app.listen({ host: HOST, port: config.env.LUMEN_PORT });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}
