import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import {
  applySettings,
  checkSettings,
  currentSettings,
  saveSettings,
  UserSettingsZ,
} from "../settings.js";

export function registerSettingsRoutes(app: FastifyInstance, handle: DbHandle, cfg: AppConfig) {
  const view = () => ({
    ...currentSettings(cfg),
    profiles: Object.keys(cfg.models.profiles),
    minMinutes: cfg.game.period.minMinutes,
    maxMinutes: cfg.game.period.maxMinutes,
    // Whether keys are set, never the keys themselves.
    hasOpenAiKey: !!process.env[cfg.models.providers.openai.apiKeyEnv],
    hasDeepSeekKey: !!process.env[cfg.models.providers.deepseek.apiKeyEnv],
  });

  app.get("/api/settings", async () => view());

  app.put("/api/settings", async (req, reply) => {
    const body = UserSettingsZ.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Those settings aren't valid." });
    const problems = checkSettings(cfg, body.data);
    if (problems.length) return reply.code(400).send({ error: problems[0], problems });
    applySettings(cfg, body.data);
    saveSettings(handle, body.data);
    return view();
  });
}
