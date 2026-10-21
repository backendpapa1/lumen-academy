import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/load.js";
import { openDb, runMigrations, type DbHandle } from "../db/client.js";
import { ModelFactory } from "../models/factory.js";
import { loadSavedSettings } from "../settings.js";
import { UsageMeter } from "../usage/meter.js";

let h: DbHandle | undefined;
afterEach(() => h?.close());

async function boot() {
  const cfg = loadConfig({ env: {} });
  h = openDb(":memory:");
  runMigrations(h);
  const meter = new UsageMeter({ db: h.db, pricing: cfg.pricing, budget: cfg.models.budget });
  const factory = new ModelFactory({ config: cfg.models, env: {}, meter });
  const app = await buildApp({
    config: cfg,
    runtime: { handle: h, factory, meter, game: cfg.game },
  });
  return { cfg, app, meter };
}

describe("/api/settings", () => {
  it("shows settings without leaking keys", async () => {
    const { app, cfg } = await boot();
    const s = (await app.inject({ method: "GET", url: "/api/settings" })).json<
      Record<string, unknown>
    >();
    expect(s).toMatchObject({
      profile: cfg.models.profile,
      periodMinutes: cfg.game.period.defaultMinutes,
    });
    expect(JSON.stringify(s)).not.toMatch(/sk-|apiKey/);
    await app.close();
  });

  it("applies changes live (budget cap, period length) and persists them", async () => {
    const { app, cfg, meter } = await boot();
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        profile: cfg.models.profile,
        monthlyUsdCap: 7,
        imagesUsdCap: 2,
        periodMinutes: 20,
        peerTalk: false,
        growthArcs: false,
      },
    });
    expect(put.statusCode).toBe(200);
    expect(cfg.game.period.defaultMinutes).toBe(20);
    // V4: peer talk and growth arcs switch off live.
    expect([cfg.game.peerTalk.enabled, cfg.game.arcs.enabled]).toEqual([false, false]);
    expect(meter.totals().capUsd).toBe(7); // the meter reads the same live object
    // A fresh config picks the saved values up at startup.
    const fresh = loadConfig({ env: {} });
    loadSavedSettings(h!, fresh);
    expect([fresh.models.budget.monthlyUsdCap, fresh.game.period.defaultMinutes]).toEqual([7, 20]);
    await app.close();
  });

  it("refuses unknown profiles, out-of-range periods and image caps above the total", async () => {
    const { app, cfg } = await boot();
    const bad = (body: object) =>
      app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: {
          profile: cfg.models.profile,
          monthlyUsdCap: 10,
          imagesUsdCap: 2,
          periodMinutes: 15,
          ...body,
        },
      });
    for (const b of [{ profile: "nope" }, { periodMinutes: 2 }, { imagesUsdCap: 50 }])
      expect((await bad(b)).statusCode).toBe(400);
    expect(cfg.models.profile).not.toBe("nope");
    await app.close();
  });
});
