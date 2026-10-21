import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { APP_NAME, WS_PATH } from "@lumen/shared";
import type { AppConfig } from "./config/load.js";
import { registerAssessmentRoutes } from "./routes/assessment.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerCampusRoutes } from "./routes/campus.js";
import { registerParkingRoutes } from "./routes/parking.js";
import { registerInsightRoutes } from "./routes/insight.js";
import { registerMeetingRoutes } from "./routes/meeting.js";
import { backfillInterests } from "./game/interests.js";
import { registerClassroomRoutes } from "./routes/classrooms.js";
import { registerSchoolRoutes } from "./routes/schools.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerSpeechRoutes } from "./routes/speech.js";
import { registerStudyRoutes } from "./routes/study.js";
import { registerClientFiles } from "./routes/clientFiles.js";
import { EventBus } from "./events.js";
import { backfillEmblems } from "./jobs.js";
import { ClassroomConnection, type Runtime } from "./ws/classroomConnection.js";
import { parseClientFrame, wsError } from "./ws/handler.js";

// The Vite dev client is the only browser origin allowed to call the API.
// LUMEN_EXTRA_ORIGINS (comma-separated, local only) adds a second dev client,
// e.g. a preview on another port against a copy of the data. When the server
// serves the client itself (the desktop app, ADR-011), its own origin is allowed.
export function clientOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const own =
    env.LUMEN_CLIENT_DIR && env.LUMEN_PORT
      ? [`http://127.0.0.1:${env.LUMEN_PORT}`, `http://localhost:${env.LUMEN_PORT}`]
      : [];
  return [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    ...own,
    ...(env.LUMEN_EXTRA_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(o)),
  ];
}
export const CLIENT_ORIGINS = clientOrigins();

export interface AppDeps {
  config: AppConfig;
  /** DB, models and meter. Without it the server only answers health and ping. */
  runtime?: Runtime;
  /** Where generated images live (<dataDir>/generated). */
  assetsDir?: string;
  /** Uploads go to <dataDir>/uploads. Needed for the School setup routes. */
  dataDir?: string;
  logger?: boolean;
}

export async function buildApp({
  config,
  runtime,
  assetsDir,
  dataDir,
  logger = false,
}: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger });

  // PUT is used by curriculum edits and settings; the default allows only GET/HEAD/POST.
  await app.register(cors, {
    origin: CLIENT_ORIGINS,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  });
  await app.register(websocket, { options: { maxPayload: 1 << 20 } });

  // Open periods must finish closing (DB writes) before the server shuts down.
  const connections = new Set<ClassroomConnection>();
  // Schools whose curriculum is being built right now. With `busy`, the Android
  // app keeps itself running while there's work in progress (ADR-012).
  const building = new Set<string>();

  app.get("/api/health", async () => ({
    ok: true,
    app: APP_NAME,
    profile: config.models.profile,
    time: new Date().toISOString(),
    busy: building.size
      ? ("building" as const)
      : [...connections].some((c) => c.live)
        ? ("class" as const)
        : null,
  }));
  // The desktop app: the server serves the built client itself (ADR-011).
  if (process.env.LUMEN_CLIENT_DIR) registerClientFiles(app, process.env.LUMEN_CLIENT_DIR);
  if (runtime) registerClassroomRoutes(app, runtime.handle, runtime.game);
  if (runtime && assetsDir) registerAssetRoutes(app, runtime.handle, assetsDir);
  if (runtime) {
    registerSettingsRoutes(app, runtime.handle, config);
    runtime.bus ??= new EventBus();
    runtime.bus.on((m) => {
      if (m.type !== "curriculum.status") return;
      if (m.payload.status === "building") building.add(m.payload.schoolId);
      else building.delete(m.payload.schoolId);
    });
    registerAssessmentRoutes(app, runtime);
    registerCampusRoutes(app, runtime);
    backfillInterests(runtime.handle, runtime.game);
    registerParkingRoutes(app, runtime);
    registerInsightRoutes(app, runtime);
    registerStudyRoutes(app, runtime);
    registerMeetingRoutes(app, runtime);
    if (dataDir) {
      const jobs = { ...runtime, bus: runtime.bus, art: config.artPrompts, dataDir };
      await registerSchoolRoutes(app, jobs);
      backfillEmblems(jobs);
    }
    if (runtime.speech) {
      await registerSpeechRoutes(app, { ...runtime, speech: runtime.speech });
      const { stt } = runtime.speech;
      app.addHook("onClose", async () => stt.close());
    }
  }

  app.addHook("onClose", async () => {
    await Promise.allSettled([...connections].map((c) => c.close()));
  });

  app.get(WS_PATH, { websocket: true }, (socket, req) => {
    // Browsers always send Origin; reject cross-site pages (CORS doesn't cover WS).
    const origin = req.headers.origin;
    if (origin && !CLIENT_ORIGINS.includes(origin)) {
      socket.close(1008, "origin not allowed");
      return;
    }
    const send = (frame: string) => {
      if (socket.readyState === socket.OPEN) socket.send(frame);
    };
    const connection = runtime ? new ClassroomConnection(runtime, send) : null;
    if (connection) connections.add(connection);
    socket.on("message", (data: Buffer) => {
      const parsed = parseClientFrame(data.toString("utf8"));
      if (!parsed.ok) return send(JSON.stringify(parsed.error));
      if (connection) return void connection.handle(parsed.msg);
      if (parsed.msg.type === "ping") {
        return send(
          JSON.stringify({
            type: "pong",
            sessionId: parsed.msg.sessionId,
            payload: { nonce: parsed.msg.payload.nonce, serverTime: new Date().toISOString() },
          }),
        );
      }
      send(JSON.stringify(wsError("unavailable", "the classroom runtime isn't running")));
    });
    socket.on("close", () => {
      if (!connection) return;
      void connection.close().finally(() => connections.delete(connection));
    });
  });

  return app;
}
