import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { agentOf, fakeDeepSeekFactory, type FakeRequest } from "../test-fixtures/fakeDeepSeek.js";
import { smallWorld } from "../test-fixtures/world.js";
import { eventTurn, maybeStartEvent, resolveEvent, type EventContext } from "./events.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());

const models = (body: FakeRequest) => {
  const who = agentOf(body);
  if (who === "grader")
    return JSON.stringify({
      score: body.messages.at(-1)!.content.includes("hashed") ? 4 : 1,
      present: [],
      missing: [],
      contradictions: [],
      rationale: "Graded.",
    });
  return JSON.stringify({
    line: "Wait, so the root lives in every transaction?",
    flaw: "The root lives in the header, not in each transaction.",
  });
};

async function setup(kinds: Array<"pop_quiz" | "glitch" | "power_flicker">) {
  const w = await smallWorld([
    { attention: 0.9, skepticism: 0.5 },
    { attention: 0.4, skepticism: 0.2 },
  ]);
  h = w.handle;
  h.sqlite
    .prepare(
      "INSERT INTO periods (id, classroom_id, started_at, planned_minutes) VALUES ('per_ev', ?, '2026-10-21T00:00:00Z', 15)",
    )
    .run(w.classroomId);
  const say = h.sqlite.prepare(
    "INSERT INTO messages (id, period_id, speaker, kind, text, created_at) VALUES (?, 'per_ev', 'teacher', 'lecture', ?, ?)",
  );
  say.run(
    "msg_a",
    "The Merkle root is stored in the block header, nowhere else.",
    "2026-10-21T00:01:00Z",
  );
  say.run(
    "msg_b",
    "Pairs of transaction hashes are hashed together up to one root.",
    "2026-10-21T00:02:00Z",
  );
  const game = { ...cfg.game, events: { ...cfg.game.events, enabled: true, kinds } };
  const { factory } = fakeDeepSeekFactory(cfg.models, models);
  const ctx: EventContext = {
    handle: h,
    factory,
    game,
    periodId: "per_ev",
    classroomId: w.classroomId,
    concept: {
      id: w.conceptIds[0]!,
      title: "Merkle Trees",
      keyFacts: ["Pairs are hashed up to a root"],
    },
    turnOrd: eventTurn(game, "per_ev")!,
    cadets: w.cadets.map((c, i) => ({
      id: c.id,
      name: `Cadet ${i}`,
      archetype: "skeptic" as const,
    })),
  };
  return {
    w,
    ctx,
    game,
    scope: { schoolId: w.schoolId, classroomId: w.classroomId, periodId: "per_ev" },
  };
}

describe("random events (M6-01)", () => {
  it("fires on one turn per period, inside the configured window", () => {
    const game = { ...cfg.game, events: { ...cfg.game.events, enabled: true } };
    for (const id of ["per_1", "per_2", "per_3", "per_4"]) {
      const t = eventTurn(game, id)!;
      expect(t).toBe(eventTurn(game, id));
      expect(t).toBeGreaterThanOrEqual(game.events.earliestTurn);
      expect(t).toBeLessThanOrEqual(game.events.latestTurn);
    }
    expect(eventTurn({ ...game, events: { ...game.events, enabled: false } }, "per_1")).toBeNull();
  });

  it("a pop quiz is graded against the key facts and pays XP per point, once per period", async () => {
    const { ctx, game, scope } = await setup(["pop_quiz"]);
    expect(await maybeStartEvent({ ...ctx, turnOrd: ctx.turnOrd + 1 })).toBeNull();
    const ev = (await maybeStartEvent(ctx))!;
    expect(ev.kind).toBe("pop_quiz");
    expect(ev.text).toContain("Merkle Trees");
    const r = await resolveEvent(
      ev,
      { text: "Pairs are hashed up to one root." },
      { handle: h!, factory: ctx.factory, game, scope },
    );
    expect(r.score).toBe(4);
    expect(r.xp).toBe(4 * game.xp.popQuizPerPoint!);
    // Saved on the period: it never fires twice.
    expect(await maybeStartEvent(ctx)).toBeNull();
    const blank = await resolveEvent(
      ev,
      { text: "  " },
      { handle: h!, factory: ctx.factory, game, scope },
    );
    expect(blank).toMatchObject({ score: 0, xp: 0 });
  });

  it("a glitch repeats an earlier teacher line wrong; catching it pays glitchCaught", async () => {
    const { ctx, game, scope } = await setup(["glitch"]);
    const ev = (await maybeStartEvent(ctx))!;
    expect(ev.kind).toBe("glitch");
    expect(ev.flaw).toMatch(/header/);
    const deps = { handle: h!, factory: ctx.factory, game, scope };
    expect(await resolveEvent(ev, { wrong: true }, deps)).toMatchObject({
      caught: true,
      xp: game.xp.glitchCaught,
    });
    expect(await resolveEvent(ev, { wrong: false }, deps)).toMatchObject({ caught: false, xp: 0 });
  });

  it("a power flicker spreads a held misconception to another cadet", async () => {
    const { ctx, w } = await setup(["power_flicker"]);
    // Nobody holds a misconception: nothing to spread, so no event.
    expect(await maybeStartEvent(ctx)).toBeNull();
    h!.sqlite
      .prepare(
        "INSERT INTO ledger_entries (cadet_id, concept_id, comprehension, exposures, misconceptions_json) VALUES (?, ?, 0.3, 2, ?)",
      )
      .run(
        w.cadets[0]!.id,
        ctx.concept.id,
        JSON.stringify([{ text: "Roots are random.", source: "archetype", since: "x" }]),
      );
    const ev = (await maybeStartEvent(ctx))!;
    expect(ev).toMatchObject({
      kind: "power_flicker",
      cadetId: w.cadets[0]!.id,
      toCadetId: w.cadets[1]!.id,
      text: "Roots are random.",
    });
    const row = h!.sqlite
      .prepare(
        "SELECT misconceptions_json FROM ledger_entries WHERE cadet_id = ? AND concept_id = ?",
      )
      .get(w.cadets[1]!.id, ctx.concept.id) as { misconceptions_json: string };
    expect(JSON.parse(row.misconceptions_json)).toEqual([
      expect.objectContaining({ text: "Roots are random.", source: "spread" }),
    ]);
  });
});
