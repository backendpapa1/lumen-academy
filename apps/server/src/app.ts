import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { APP_NAME, WS_PATH } from "@lumen/shared";
import type { AppConfig } from "./config/load.js";
import { handleClientMessage, parseClientFrame } from "./ws/handler.js";

// The Vite dev client is the only browser origin allowed to call the API.
export const CLIENT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

export interface AppDeps {
  config: AppConfig;
  logger?: boolean;
}

export async function buildApp({ config, logger = false }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger });

  await app.register(cors, { origin: CLIENT_ORIGINS });
  await app.register(websocket, { options: { maxPayload: 1 << 20 } });

  app.get("/api/health", async () => ({
    ok: true,
    app: APP_NAME,
    profile: config.models.profile,
    time: new Date().toISOString(),
  }));

  app.get(WS_PATH, { websocket: true }, (socket, req) => {
    // Browsers always send Origin; reject cross-site pages (CORS doesn't cover WS).
    const origin = req.headers.origin;
    if (origin && !CLIENT_ORIGINS.includes(origin)) {
      socket.close(1008, "origin not allowed");
      return;
    }
    socket.on("message", (data: Buffer) => {
      const parsed = parseClientFrame(data.toString("utf8"));
      const reply = parsed.ok ? handleClientMessage(parsed.msg) : parsed.error;
      socket.send(JSON.stringify(reply));
    });
  });

  return app;
}
