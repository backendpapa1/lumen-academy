import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { ModelFactory } from "../models/factory.js";
import { smallWorld } from "../test-fixtures/world.js";
import { UsageMeter } from "../usage/meter.js";

let h: DbHandle | undefined;
afterEach(() => h?.close());

describe("parking lot (V3-04)", () => {
  it("files a thought, lists it for its period, and resolves it", async () => {
    const cfg = loadConfig({ env: {} });
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    h = w.handle;
    const meter = new UsageMeter({ db: h.db, pricing: cfg.pricing, budget: cfg.models.budget });
    const factory = new ModelFactory({ config: cfg.models, env: {}, meter });
    const app = await buildApp({
      config: cfg,
      runtime: { handle: h, factory, meter, game: cfg.game },
    });
    const url = `/api/schools/${w.schoolId}/parking`;

    const a = await app.inject({
      method: "POST",
      url,
      payload: { text: "  Is a Merkle tree the same as a hash list?  ", periodId: "per_1" },
    });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ text: "Is a Merkle tree the same as a hash list?", open: 1 });
    await app.inject({ method: "POST", url, payload: { text: "Look up SPV wallets" } });
    expect((await app.inject({ method: "POST", url, payload: { text: " " } })).statusCode).toBe(
      400,
    );

    const forPeriod = (await app.inject({ url: `${url}?periodId=per_1` })).json<unknown[]>();
    expect(forPeriod).toHaveLength(1);

    const id = a.json<{ id: string }>().id;
    const r = await app.inject({
      method: "PATCH",
      url: `/api/parking/${id}`,
      payload: { status: "kept" },
    });
    expect(r.json()).toEqual({ id, status: "kept" });
    expect((await app.inject({ url })).json<Array<{ text: string }>>().map((p) => p.text)).toEqual([
      "Look up SPV wallets",
    ]);
    expect((await app.inject({ url: `${url}?status=kept` })).json<unknown[]>()).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/parking/prk_x",
          payload: { status: "kept" },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });
});
