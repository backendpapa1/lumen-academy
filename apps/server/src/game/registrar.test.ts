import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import { openDb, runMigrations, type DbHandle } from "../db/client.js";
import { cadets, classrooms } from "../db/schema.js";
import { ensureSchool } from "../ingest/pipeline.js";
import { fakeDeepSeekFactory } from "../test-fixtures/fakeDeepSeek.js";
import { registerClassroom } from "./registrar.js";
import { planCohort } from "./registration.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle;
let schoolId: string;
beforeEach(() => {
  h = openDb(":memory:");
  runMigrations(h);
  schoolId = ensureSchool(h, "Blockchain").id;
});
afterEach(() => h.close());

/** Answers flavour requests for whatever indices the prompt lists. */
function flavourer(opts: { duplicateOnce?: boolean } = {}) {
  let dupSent = false;
  return (body: { messages: Array<{ role: string; content: string }> }) => {
    const prompt = body.messages.map((m) => m.content).join("\n");
    const indices = [...prompt.matchAll(/^(\d+)\. [A-Z]/gm)].map((m) => Number(m[1]));
    const cadetsOut = indices.map((i) => ({
      index: i,
      name: opts.duplicateOnce && !dupSent && i === 2 ? "Cadet 1" : `Cadet ${i}`,
      quirk: `quirk ${i}`,
      voiceNotes: `voice ${i}`,
      backstory: `story ${i}`,
      visualQuirk: `scar ${i}`,
      hair: "short",
    }));
    if (opts.duplicateOnce && indices.includes(2)) dupSent = true;
    return JSON.stringify({ cadets: cadetsOut });
  };
}

describe("registerClassroom", () => {
  it("enrols the planned cohort in batches, firing arrivals in order", async () => {
    const { factory, calls } = fakeDeepSeekFactory(cfg.models, flavourer());
    const arrivals: Array<[string, number, number]> = [];
    const res = await registerClassroom(
      { handle: h, factory, game: cfg.game },
      { schoolId, seed: 7, onArrival: (c, i, n) => arrivals.push([c.name, i, n]) },
    );

    const plan = planCohort(7, "standard", cfg.game);
    expect(res.cadets).toHaveLength(plan.length);
    expect(res.name).toBe("Class A");
    expect(calls).toHaveLength(Math.ceil(plan.length / cfg.game.registration.batchSize));
    expect(arrivals.map((a) => a[1])).toEqual(plan.map((_, i) => i + 1));
    expect(arrivals.every((a) => a[2] === plan.length)).toBe(true);

    const rows = h.db.select().from(cadets).where(eq(cadets.classroomId, res.classroomId)).all();
    expect(rows.map((r) => r.archetype).sort()).toEqual(plan.map((p) => p.archetype).sort());
    expect(JSON.parse(rows[0]!.traitsJson).appearance.hair).toBe("short");
    expect(h.db.select().from(classrooms).get()).toMatchObject({
      status: "active",
      seed: 7,
      difficulty: "standard",
    });
  });

  it("re-asks a batch once when the model repeats a name", async () => {
    const { factory, calls } = fakeDeepSeekFactory(cfg.models, flavourer({ duplicateOnce: true }));
    const res = await registerClassroom(
      { handle: h, factory, game: cfg.game },
      { schoolId, seed: 7 },
    );
    expect(new Set(res.cadets.map((c) => c.name)).size).toBe(res.cadets.length);
    expect(calls.length).toBe(Math.ceil(res.cadets.length / cfg.game.registration.batchSize) + 1);
  });

  it("names classrooms A, B, … and enforces the per-school maximum", async () => {
    const { factory } = fakeDeepSeekFactory(cfg.models, flavourer());
    const game = { ...cfg.game, classroomsPerSchool: 2 };
    expect(
      (await registerClassroom({ handle: h, factory, game }, { schoolId, seed: 1 })).name,
    ).toBe("Class A");
    expect(
      (await registerClassroom({ handle: h, factory, game }, { schoolId, seed: 2 })).name,
    ).toBe("Class B");
    await expect(
      registerClassroom({ handle: h, factory, game }, { schoolId, seed: 3 }),
    ).rejects.toThrow(/at most 2/);
  });
});
