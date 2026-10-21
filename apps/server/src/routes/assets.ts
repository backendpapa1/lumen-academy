import { createReadStream, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import type { FastifyInstance } from "fastify";
import type { DbHandle } from "../db/client.js";

// Generated images, by asset id (docs/07). Only ready rows are served, and
// only from inside the generated directory.

export function registerAssetRoutes(app: FastifyInstance, handle: DbHandle, dir: string) {
  app.get<{ Params: { id: string } }>("/api/assets/:id", async (req, reply) => {
    const row = handle.sqlite
      .prepare("SELECT file_path AS filePath, status FROM assets WHERE id = ?")
      .get(req.params.id) as { filePath: string | null; status: string } | undefined;
    if (!row || row.status !== "ready" || !row.filePath)
      return reply.code(404).send({ error: "no such asset (yet)" });
    const abs = normalize(join(dir, row.filePath));
    if (!abs.startsWith(normalize(dir)) || !existsSync(abs))
      return reply.code(404).send({ error: "asset file missing" });
    // Content-addressed by prompt hash: safe to cache for good.
    return reply
      .header("content-type", "image/webp")
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(createReadStream(abs));
  });
}
