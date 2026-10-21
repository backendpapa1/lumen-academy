import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/load.js";
import { openDb, runMigrations, type DbHandle } from "../db/client.js";
import { ModelFactory } from "../models/factory.js";
import { UsageMeter } from "../usage/meter.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());

describe("GET /api/assets/:id", () => {
  it("serves ready assets as immutable webp, 404s the rest, and never leaves the generated dir", async () => {
    h = openDb(":memory:");
    runMigrations(h);
    const dir = mkdtempSync(join(tmpdir(), "lumen-gen-"));
    mkdirSync(join(dir, "portrait"));
    writeFileSync(join(dir, "portrait", "a.webp"), Buffer.from("RIFFxxxxWEBP"));
    const ins = h.sqlite.prepare(
      "INSERT INTO assets (id, kind, prompt, prompt_hash, model, params_json, status, file_path, created_at) VALUES (?, 'portrait', 'p', ?, 'm', '{}', ?, ?, '2026-01-01')",
    );
    ins.run("ast_ok", "h1", "ready", "portrait/a.webp");
    ins.run("ast_wip", "h2", "generating", null);
    ins.run("ast_evil", "h3", "ready", "../../etc/passwd");
    const meter = new UsageMeter({ db: h.db, pricing: cfg.pricing, budget: cfg.models.budget });
    const app = await buildApp({
      config: cfg,
      assetsDir: dir,
      runtime: {
        handle: h,
        factory: new ModelFactory({ config: cfg.models, env: {}, meter }),
        meter,
        game: cfg.game,
      },
    });
    const ok = await app.inject({ method: "GET", url: "/api/assets/ast_ok" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/webp");
    expect(ok.headers["cache-control"]).toContain("immutable");
    expect(ok.body).toContain("WEBP");
    for (const id of ["ast_wip", "ast_evil", "ast_none"])
      expect((await app.inject({ method: "GET", url: `/api/assets/${id}` })).statusCode).toBe(404);
    await app.close();
  });
});
