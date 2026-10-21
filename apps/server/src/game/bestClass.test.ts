import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { smallWorld } from "../test-fixtures/world.js";
import { bestClass } from "./bestClass.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());

const now = new Date("2026-10-21T09:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

describe("today's best class (V3-03)", () => {
  it("starts at the beginning, then the next untaught concept, then the weakest", async () => {
    const w = await smallWorld([
      { attention: 0.5, skepticism: 0.5 },
      { attention: 0.5, skepticism: 0.5 },
    ]);
    h = w.handle;
    const [first, second] = w.conceptIds as [string, string];
    expect(bestClass(h, cfg.game, now)).toMatchObject({ conceptId: first, why: "next" });

    const put = h.sqlite.prepare(
      "INSERT OR REPLACE INTO ledger_entries (cadet_id, concept_id, comprehension, exposures, misconceptions_json, last_taught_at) VALUES (?, ?, ?, 3, '[]', ?)",
    );
    for (const c of w.cadets) put.run(c.id, first, 0.6, daysAgo(0));
    expect(bestClass(h, cfg.game, now)).toMatchObject({ conceptId: second, why: "next" });
    expect(bestClass(h, cfg.game, now)!.reason).toMatch(/nobody/);

    for (const c of w.cadets) put.run(c.id, second, 0.3, daysAgo(0));
    expect(bestClass(h, cfg.game, now)).toMatchObject({ conceptId: second, why: "weak" });
  });

  it("a fading concept comes first", async () => {
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    h = w.handle;
    const [first, second] = w.conceptIds as [string, string];
    const put = h.sqlite.prepare(
      "INSERT INTO ledger_entries (cadet_id, concept_id, comprehension, exposures, misconceptions_json, last_taught_at, stability_days) VALUES (?, ?, ?, 3, '[]', ?, 2)",
    );
    put.run(w.cadets[0]!.id, first, 0.9, daysAgo(10));
    put.run(w.cadets[0]!.id, second, 0.2, daysAgo(0));
    expect(bestClass(h, cfg.game, now)).toMatchObject({ conceptId: first, why: "fading" });
  });
});
