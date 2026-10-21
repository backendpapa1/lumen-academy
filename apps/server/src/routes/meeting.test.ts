import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { fakeDeepSeekFactory, type FakeRequest } from "../test-fixtures/fakeDeepSeek.js";
import { smallWorld } from "../test-fixtures/world.js";
import { UsageMeter } from "../usage/meter.js";

let h: DbHandle | undefined;
afterEach(() => h?.close());

describe("parent–teacher meeting (V5-10)", () => {
  it("the parent opens with the struggling child's evidence, then responds to me", async () => {
    const cfg = loadConfig({ env: {} });
    const w = await smallWorld([
      { attention: 0.5, skepticism: 0.5 },
      { attention: 0.5, skepticism: 0.5 },
    ]);
    h = w.handle;
    const put = h.sqlite.prepare(
      "INSERT INTO ledger_entries (cadet_id, concept_id, comprehension, exposures, misconceptions_json, last_taught_at) VALUES (?, ?, ?, 3, ?, ?)",
    );
    const at = new Date().toISOString();
    put.run(w.cadets[0]!.id, w.conceptIds[0], 0.8, "[]", at);
    put.run(
      w.cadets[1]!.id,
      w.conceptIds[0],
      0.2,
      JSON.stringify([{ text: "The root is in every transaction." }]),
      at,
    );
    const seen: FakeRequest[] = [];
    const meter = new UsageMeter({ db: h.db, pricing: cfg.pricing, budget: cfg.models.budget });
    const { factory } = fakeDeepSeekFactory(
      cfg.models,
      (body) => {
        seen.push(body);
        return JSON.stringify({
          reply: "Why did my son struggle?",
          satisfied: false,
          pushback: true,
        });
      },
      { meter },
    );
    const app = await buildApp({
      config: cfg,
      runtime: { handle: h, factory, meter, game: cfg.game },
    });
    const open = await app.inject({
      method: "POST",
      url: `/api/classrooms/${w.classroomId}/meeting`,
      payload: { history: [] },
    });
    expect(open.statusCode).toBe(200);
    expect(open.json()).toMatchObject({ child: { id: w.cadets[1]!.id }, pushback: true });
    const sys = seen[0]!.messages.map((m) => m.content).join("\n");
    expect(sys).toContain("believes: The root is in every transaction.");
    const next = await app.inject({
      method: "POST",
      url: `/api/classrooms/${w.classroomId}/meeting`,
      payload: {
        history: [
          { who: "parent", text: "Why did my son struggle?" },
          {
            who: "teacher",
            text: "He thinks the root is in every transaction; I'll fix that first.",
          },
        ],
      },
    });
    expect(next.statusCode).toBe(200);
    await app.close();
  });
});
