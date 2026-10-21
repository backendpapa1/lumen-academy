import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import { smallWorld } from "../test-fixtures/world.js";
import { fadingTarget } from "./fading.js";

const game = loadConfig({ env: {} }).game;

describe("your class is forgetting (V2-03)", () => {
  it("picks the concept the class has let slip most, and nothing when it's fresh", async () => {
    const w = await smallWorld([
      { attention: 0.5, skepticism: 0.5 },
      { attention: 0.6, skepticism: 0.3 },
    ]);
    const now = new Date("2026-10-30T09:00:00Z");
    const put = h(w);
    // Concept 0: well known, taught 10 days ago. Concept 1: half known, 1 day ago.
    for (const c of w.cadets) {
      put(c.id, w.conceptIds[0]!, 0.9, "2026-10-20T09:00:00Z");
      put(c.id, w.conceptIds[1]!, 0.5, "2026-10-29T09:00:00Z");
    }
    const t = fadingTarget(w.handle, game, now)!;
    expect(t.conceptId).toBe(w.conceptIds[0]);
    expect(t.days).toBe(10);
    expect(t.was).toBeCloseTo(0.9);
    expect(t.now).toBeLessThan(0.9 * game.memory.fadingAt);
    // Everything freshly taught: nothing is fading.
    expect(fadingTarget(w.handle, game, new Date("2026-10-20T10:00:00Z"))).toBeNull();
    w.handle.close();
  });
});

function h(w: Awaited<ReturnType<typeof smallWorld>>) {
  const stmt = w.handle.sqlite.prepare(
    `INSERT INTO ledger_entries (cadet_id, concept_id, comprehension, exposures, misconceptions_json, last_taught_at)
     VALUES (?, ?, ?, 3, '[]', ?) ON CONFLICT (cadet_id, concept_id) DO UPDATE SET comprehension = excluded.comprehension, last_taught_at = excluded.last_taught_at, exposures = 3`,
  );
  return (cadet: string, concept: string, c: number, at: string) => stmt.run(cadet, concept, c, at);
}
