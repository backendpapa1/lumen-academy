import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { FastifyInstance } from "fastify";

// The desktop app (ADR-011): the built client served from the same origin as
// the API, so the window needs no CORS and no second port. Read-only, inside
// the client folder only; anything unknown falls back to index.html.

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export function registerClientFiles(app: FastifyInstance, dir: string) {
  const root = normalize(dir) + sep;
  const index = join(root, "index.html");
  if (!existsSync(index)) {
    app.log.warn(`LUMEN_CLIENT_DIR has no index.html: ${dir}`);
    return;
  }
  app.get("/*", async (req, reply) => {
    const path = decodeURIComponent(req.url.split("?")[0]!);
    if (path.startsWith("/api/") || path === "/ws")
      return reply.code(404).send({ error: "not found" });
    const file = normalize(join(root, path));
    const inside = file.startsWith(root) && existsSync(file) && statSync(file).isFile();
    const target = inside ? file : index;
    const type = TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    // Hashed assets keep forever; the page itself is always fresh.
    reply.header(
      "cache-control",
      target === index
        ? "no-cache"
        : path.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
    );
    return reply.type(type).send(readFileSync(target));
  });
}
