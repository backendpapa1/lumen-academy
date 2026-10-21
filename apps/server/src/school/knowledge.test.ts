import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import { smallWorld } from "../test-fixtures/world.js";
import { knowledgeMarkdown, knowledgeReport } from "./knowledge.js";

const game = loadConfig({ env: {} }).game;

describe("what I actually know (V2-07/08)", () => {
  it("buckets concepts from the evidence and flags where my rating disagrees", async () => {
    const w = await smallWorld([
      { attention: 0.5, skepticism: 0.5 },
      { attention: 0.6, skepticism: 0.3 },
    ]);
    const now = new Date("2026-10-22T09:00:00Z");
    const fresh = "2026-10-22T08:00:00Z";
    const led = w.handle.sqlite.prepare(
      `INSERT INTO ledger_entries (cadet_id, concept_id, comprehension, exposures, misconceptions_json, last_taught_at)
       VALUES (?, ?, ?, ?, '[]', ?) ON CONFLICT (cadet_id, concept_id) DO UPDATE SET comprehension = excluded.comprehension, exposures = excluded.exposures, last_taught_at = excluded.last_taught_at`,
    );
    const [merkle, header] = w.conceptIds as [string, string];
    for (const c of w.cadets) {
      led.run(c.id, merkle, 0.9, 4, fresh); // well taught, fresh
      led.run(c.id, header, 0.4, 2, fresh); // taught, middling
    }
    w.handle.sqlite
      .prepare("INSERT INTO self_ratings (concept_id, rating, updated_at) VALUES (?, 5, ?)")
      .run(header, fresh);
    w.handle.sqlite
      .prepare("INSERT INTO self_ratings (concept_id, rating, updated_at) VALUES (?, 5, ?)")
      .run(merkle, fresh);
    const r = knowledgeReport(w.handle, game, w.schoolId, now)!;
    const by = Object.fromEntries(r.concepts.map((c) => [c.id, c]));
    expect(by[merkle]).toMatchObject({ status: "mastered", mismatch: null });
    expect(by[header]).toMatchObject({ status: "shaky", mismatch: "over" }); // I rate it 5, the class is at 40%
    const untaught = r.concepts.filter((c) => c.id !== merkle && c.id !== header);
    expect(untaught.every((c) => c.status === "avoided")).toBe(true);
    expect(r.agreement).toEqual({ rated: 2, within: 1 });
    const md = knowledgeMarkdown(r);
    expect(md).toMatch(/^# What I actually know: Blockchain/);
    expect(md.indexOf("## Shaky")).toBeLessThan(md.indexOf("## Mastered"));
    w.handle.close();
  });
});
