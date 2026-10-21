import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/load.js";
import type { DbHandle } from "./db/client.js";
import { EventBus } from "./events.js";
import { fakeDeepSeekFactory } from "./test-fixtures/fakeDeepSeek.js";
import { smallWorld } from "./test-fixtures/world.js";
import { UsageMeter } from "./usage/meter.js";

const cfg = loadConfig({ env: {} });
let app: FastifyInstance | undefined;
let h: DbHandle | undefined;
afterEach(async () => {
  await app?.close();
  h?.close();
});

describe("/api/health busy (the Android app stays up while there's work: ADR-012)", () => {
  it("says building while any School's curriculum builds, and nothing after", async () => {
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    h = w.handle;
    const meter = new UsageMeter({ db: h.db, pricing: cfg.pricing, budget: cfg.models.budget });
    const { factory } = fakeDeepSeekFactory(cfg.models, () => "{}", { meter });
    const bus = new EventBus();
    app = await buildApp({
      config: cfg,
      runtime: { handle: h, factory, meter, game: cfg.game, bus },
    });
    const busy = async () => (await app!.inject({ method: "GET", url: "/api/health" })).json().busy;
    expect(await busy()).toBeNull();
    bus.emit({ type: "curriculum.status", payload: { schoolId: "sch_a", status: "building" } });
    bus.emit({ type: "curriculum.status", payload: { schoolId: "sch_b", status: "building" } });
    expect(await busy()).toBe("building");
    bus.emit({ type: "curriculum.status", payload: { schoolId: "sch_a", status: "ready" } });
    expect(await busy()).toBe("building");
    bus.emit({
      type: "curriculum.status",
      payload: { schoolId: "sch_b", status: "error", detail: "x" },
    });
    expect(await busy()).toBeNull();
  });
});
