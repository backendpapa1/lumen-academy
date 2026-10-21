import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { fakeDeepSeekFactory } from "../test-fixtures/fakeDeepSeek.js";
import { smallWorld } from "../test-fixtures/world.js";
import { UsageMeter } from "../usage/meter.js";

const cfg = loadConfig({ env: {} });
let app: FastifyInstance | undefined;
let h: DbHandle | undefined;
afterEach(async () => {
  await app?.close();
  h?.close();
});

async function boot() {
  const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
  h = w.handle;
  const meter = new UsageMeter({ db: h.db, pricing: cfg.pricing, budget: cfg.models.budget });
  const { factory } = fakeDeepSeekFactory(cfg.models, () => "{}", { meter });
  app = await buildApp({
    config: cfg,
    dataDir: mkdtempSync(join(tmpdir(), "lumen-study-")),
    runtime: { handle: h, factory, meter, game: cfg.game },
  });
  return { w, app };
}

describe("study session (Paul's note)", () => {
  it("lists the School's sources, reads one as text, and keeps a notebook", async () => {
    const { w, app } = await boot();
    const sid = (w.handle.sqlite.prepare("SELECT id FROM sources").get() as { id: string }).id;
    w.handle.sqlite.prepare("UPDATE sources SET status = 'ready' WHERE id = ?").run(sid);
    const study = (
      await app.inject({ method: "GET", url: `/api/schools/${w.schoolId}/study` })
    ).json<{
      sources: Array<{ id: string; original: boolean }>;
      notes: { body: string; updatedAt: string | null };
    }>();
    expect(study.sources.map((s) => s.id)).toEqual([sid]);
    expect(study.notes).toEqual({ body: "", updatedAt: null });

    const text = (
      await app.inject({ method: "GET", url: `/api/schools/${w.schoolId}/sources/${sid}/text` })
    ).json<{ sections: Array<{ text: string }> }>();
    expect(text.sections.length).toBeGreaterThan(0);

    const put = await app.inject({
      method: "PUT",
      url: `/api/schools/${w.schoolId}/study/notes`,
      payload: { body: "# Merkle trees\nPairs hash up to one root." },
    });
    expect(put.statusCode).toBe(200);
    const again = (
      await app.inject({ method: "GET", url: `/api/schools/${w.schoolId}/study` })
    ).json<{
      notes: { body: string };
    }>();
    expect(again.notes.body).toBe("# Merkle trees\nPairs hash up to one root.");
  });

  it("serves a PDF original inline, and nothing for another School's source", async () => {
    const { w, app } = await boot();
    const sid = (w.handle.sqlite.prepare("SELECT id FROM sources").get() as { id: string }).id;
    const pdf = join(mkdtempSync(join(tmpdir(), "lumen-pdf-")), "a.pdf");
    writeFileSync(pdf, "%PDF-1.4 fake");
    w.handle.sqlite
      .prepare("UPDATE sources SET status = 'ready', kind = 'pdf', file_path = ? WHERE id = ?")
      .run(pdf, sid);
    const res = await app.inject({
      method: "GET",
      url: `/api/schools/${w.schoolId}/sources/${sid}/file`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/^inline/);
    expect(
      (await app.inject({ method: "GET", url: `/api/schools/sch_other/sources/${sid}/file` }))
        .statusCode,
    ).toBe(404);
  });
});
