import { afterEach, describe, expect, it } from "vitest";
import type { ReactionState } from "@lumen/shared";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { concepts, ledgerEntries, messages, periods, teacherErrors, turns } from "../db/schema.js";
import { agentOf, fakeDeepSeekFactory, type FakeRequest } from "../test-fixtures/fakeDeepSeek.js";
import { smallWorld } from "../test-fixtures/world.js";
import { ClassSession } from "./ClassSession.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Script {
  director?: (body: FakeRequest, call: number) => Promise<string> | string;
}

/** Reactor: everyone attentive except seat 2 confused, who raises a hand. Director: tags the concept id it's told. */
async function setup(script: Script = {}) {
  const w = await smallWorld([
    { attention: 0.8, skepticism: 0.5 },
    { attention: 0.5, skepticism: 0.1 },
    { attention: 0.6, skepticism: 0.9 },
  ]);
  h = w.handle;
  let directorCalls = 0;
  const { factory, calls } = fakeDeepSeekFactory(cfg.models, (body) => {
    if (agentOf(body) === "crowdReactor")
      return "1 attentive\n2 confused\n3 notetaking\nH 2 clarify 0.8 Wait, where does the root live?\n";
    directorCalls++;
    if (script.director) return script.director(body, directorCalls);
    const said = body.messages.at(-1)!.content;
    return directorJson(
      w.conceptIds[0]!,
      said.includes("WRONG")
        ? [
            {
              claim: "The root is in every transaction.",
              correction: "Header only.",
              citation: "kf1",
            },
          ]
        : [],
    );
  });
  return { w, factory, calls };
}

const directorJson = (conceptId: string, errors: unknown[] = []) =>
  JSON.stringify({
    conceptIds: [conceptId],
    teaching: {
      accuracy: errors.length ? 0.2 : 1,
      clarity: 0.85,
      coverage: ["Merkle Trees a"],
      errors,
    },
    ledgerDeltas: [],
  });

describe("ClassSession: suspend and resume", () => {
  it("resumes a recently suspended period, but closes one left too long", async () => {
    const { w, factory } = await setup();
    let now = Date.parse("2026-10-21T09:00:00Z");
    const deps = { handle: w.handle, factory, game: cfg.game, now: () => now };
    const a = ClassSession.open(deps, { classroomId: w.classroomId });
    now += 4 * 60_000;
    await a.suspend();
    expect(a.elapsedMs()).toBe(4 * 60_000);

    now += 60 * 60_000; // an hour away doesn't count
    const b = ClassSession.open(deps, { classroomId: w.classroomId, resume: true });
    expect(b).toMatchObject({ periodId: a.periodId, resumed: true, paused: true });
    expect(b.elapsedMs()).toBe(4 * 60_000);
    b.resume();
    now += 60_000;
    expect(b.periodMinute()).toBe(5);
    b.pause();
    now += 10 * 60_000;
    expect(b.periodMinute()).toBe(5);
    expect(() => b.teach("hello")).toThrow(/paused/);
    await b.suspend();

    // Past the resume window: that period is closed and a fresh one starts.
    now = Date.now() + (cfg.game.period.resumeWithinHours + 1) * 3_600_000;
    const c = ClassSession.open(deps, { classroomId: w.classroomId, resume: true });
    expect(c.periodId).not.toBe(a.periodId);
    expect(c.resumed).toBe(false);
    const old = w.handle.db
      .select()
      .from(periods)
      .all()
      .find((p) => p.id === a.periodId)!;
    expect(old.endedAt).not.toBeNull();
    expect(old.elapsedMs).toBe(5 * 60_000);
    await c.close();
  });

  it("without resume, unfinished periods are closed and a new one opens", async () => {
    const { w, factory } = await setup();
    const deps = { handle: w.handle, factory, game: cfg.game };
    const a = ClassSession.open(deps, { classroomId: w.classroomId });
    await a.suspend();
    const b = ClassSession.open(deps, { classroomId: w.classroomId });
    expect(b.periodId).not.toBe(a.periodId);
    const open = w.handle.db
      .select()
      .from(periods)
      .all()
      .filter((p) => !p.endedAt);
    expect(open.map((p) => p.id)).toEqual([b.periodId]);
    await b.close();
  });
});

describe("ClassSession", () => {
  it("streams reactions, queues hands, then commits ledger, turn and messages", async () => {
    const { w, factory } = await setup();
    const reactions: Array<[string, ReactionState]> = [];
    const queues: string[][] = [];
    const s = ClassSession.open(
      { handle: w.handle, factory, game: cfg.game },
      { classroomId: w.classroomId },
      {
        onReaction: (id, st) => reactions.push([id, st]),
        onHands: (q) => queues.push(q.map((x) => x.cadetId)),
      },
    );

    const t = s.teach("Picture a tournament bracket: transactions pair up and get hashed.");
    const r = await t.reaction;
    expect(r?.reaction.reactions.map((x) => x.state)).toEqual([
      "attentive",
      "confused",
      "notetaking",
    ]);
    expect(reactions).toHaveLength(3);
    expect(s.handQueue.map((x) => [x.cadetId, x.intent])).toEqual([[w.cadets[1]!.id, "clarify"]]);

    const c = await t.committed;
    expect(c.lowConfidence).toBe(false);
    expect(c.changes).toHaveLength(3);
    expect(
      h!.db
        .select()
        .from(ledgerEntries)
        .all()
        .every((l) => l.comprehension > 0 && l.exposures === 1),
    ).toBe(true);
    const turn = h!.db.select().from(turns).get()!;
    expect(turn).toMatchObject({ ord: 1, lowConfidence: false });
    expect(JSON.parse(turn.reactionsJson).reactions).toHaveLength(3);
    expect(h!.db.select().from(messages).all()).toMatchObject([
      { speaker: "teacher", kind: "lecture", conceptId: w.conceptIds[0] },
    ]);
    expect(
      h!.db
        .select()
        .from(concepts)
        .all()
        .find((x) => x.id === w.conceptIds[0])!.status,
    ).toBe("taught");
    await s.close();
    expect(h!.db.select().from(periods).get()!.endedAt).toBeTruthy();
  });

  it("builds turn N+1 only after turn N's ledger is committed (ADR-002)", async () => {
    const { w, factory, calls } = await setup({
      director: async (body, n) => {
        if (n === 1) await sleep(80);
        return directorJson(body.messages.join("").length ? smallId(body) : "", []);
      },
    });
    const s = ClassSession.open(
      { handle: w.handle, factory, game: cfg.game },
      { classroomId: w.classroomId },
    );
    const t1 = s.teach("First idea.");
    const t2 = s.teach("Second idea.");
    await Promise.all([t1.committed, t2.committed]);
    const secondDirector = calls.filter((b) => agentOf(b) === "classDirector")[1]!;
    const table = secondDirector.messages.find((m) => m.content.includes("Students (id"))!.content;
    expect(table).not.toMatch(/\| 0\.00 \| -/); // turn 1's comprehension is visible to turn 2
    expect(secondDirector.messages.at(-1)!.content).toContain("Teacher: First idea.");
    await s.close();
  });

  it("records teacher errors privately and spreads them to credulous cadets", async () => {
    const { w, factory } = await setup();
    const s = ClassSession.open(
      { handle: w.handle, factory, game: cfg.game },
      { classroomId: w.classroomId },
    );
    const c = await s.teach("WRONG: the root sits in every transaction.").committed;
    expect(h!.db.select().from(teacherErrors).all()).toMatchObject([
      { claim: "The root is in every transaction.", resolved: false },
    ]);
    expect(c.analysis.teaching.accuracy).toBe(0.2);
    await s.close();
  });

  it("retries a slow Director once and marks the turn low-confidence", async () => {
    const { w, factory } = await setup({
      director: async (body, n) => {
        if (n === 1) await sleep(120);
        return directorJson(smallId(body));
      },
    });
    const s = ClassSession.open(
      { handle: w.handle, factory, game: cfg.game, directorTimeoutMs: 40 },
      { classroomId: w.classroomId },
    );
    const c = await s.teach("Hashing in pairs.").committed;
    expect(c.lowConfidence).toBe(true);
    expect(h!.db.select().from(turns).get()!.lowConfidence).toBe(true);
    await s.close();
  });

  it("falls back to a neutral turn when the Director fails twice", async () => {
    const errors: string[] = [];
    const { w, factory } = await setup({ director: () => "not json at all" });
    const s = ClassSession.open(
      { handle: w.handle, factory, game: cfg.game },
      { classroomId: w.classroomId },
      { onError: (stage) => errors.push(stage) },
    );
    const c = await s.teach("Something.").committed;
    expect(errors).toEqual(["director"]);
    expect(c.analysis.conceptIds).toEqual([]);
    expect(h!.db.select().from(ledgerEntries).all()).toEqual([]);
    expect(h!.db.select().from(turns).all()).toHaveLength(1);
    await s.close();
  });

  it("follows the Director to a new concept after two tagged turns (T-6), and obeys an explicit tag", async () => {
    let target = "";
    const { w, factory } = await setup({ director: () => directorJson(target) });
    target = w.conceptIds[1]!;
    const changes: string[] = [];
    const s = ClassSession.open(
      { handle: w.handle, factory, game: cfg.game },
      { classroomId: w.classroomId },
      { onConceptChange: (_id, title) => changes.push(title) },
    );
    await s.teach("Now headers.").committed;
    expect(s.currentConcept.id).toBe(w.conceptIds[0]);
    await s.teach("Headers have six fields.").committed;
    expect(s.currentConcept.id).toBe(w.conceptIds[1]);
    expect(changes).toEqual(["Block Header"]);
    await s.teach("Back to Merkle trees.", { conceptId: w.conceptIds[0] }).committed;
    expect(s.currentConcept.id).toBe(w.conceptIds[0]);
    await s.close();
  });

  it("interrupting a speaking cadet aborts them and returns their hand", async () => {
    const { w, factory } = await setup();
    const s = ClassSession.open(
      { handle: w.handle, factory, game: cfg.game },
      { classroomId: w.classroomId },
    );
    const t = s.teach("Merkle trees.");
    await t.reaction;
    const speaking = s.call(w.cadets[1]!.id);
    expect(s.handQueue).toHaveLength(0);
    s.teach("Hold on, let me add something.");
    expect(speaking.signal.aborted).toBe(true);
    expect(s.handQueue.map((x) => x.cadetId)).toContain(w.cadets[1]!.id);
    await s.close();
    expect(() => s.teach("after close")).toThrow(/ended/);
  });
});

/** The current concept id, read back from the Director prompt. */
function smallId(body: FakeRequest): string {
  const sys = body.messages.map((m) => m.content).join("\n");
  return /Current concept \((cpt_[0-9a-z]+)\)/.exec(sys)?.[1] ?? "";
}

describe("ClassSession: micro-lessons and energy (V3-01/02)", () => {
  it("a micro-lesson seats only the student who knows the concept least, for a few minutes", async () => {
    const { w, factory } = await setup();
    const deps = { handle: w.handle, factory, game: cfg.game };
    // Seat 2 knows it least.
    const put = w.handle.sqlite.prepare(
      "INSERT INTO ledger_entries (cadet_id, concept_id, comprehension, exposures, misconceptions_json) VALUES (?, ?, ?, 2, '[]')",
    );
    put.run(w.cadets[0]!.id, w.conceptIds[0], 0.7);
    put.run(w.cadets[1]!.id, w.conceptIds[0], 0.1);
    put.run(w.cadets[2]!.id, w.conceptIds[0], 0.5);
    const s = ClassSession.open(deps, {
      classroomId: w.classroomId,
      conceptId: w.conceptIds[0],
      kind: "micro",
    });
    expect(s.roster.map((r) => r.id)).toEqual([w.cadets[1]!.id]);
    expect(s).toMatchObject({ kind: "micro", plannedMinutes: cfg.game.micro.minutes, quiet: true });
    await s.suspend();
    // Resuming keeps it a micro-lesson with the same student, whatever is asked.
    const again = ClassSession.open(deps, { classroomId: w.classroomId, resume: true });
    expect(again).toMatchObject({ periodId: s.periodId, kind: "micro" });
    expect(again.roster).toHaveLength(1);
    await again.close();
  });

  it("low energy makes the class gentle and quiet; it's saved on the period", async () => {
    const { w, factory } = await setup();
    const s = ClassSession.open(
      { handle: w.handle, factory, game: cfg.game },
      { classroomId: w.classroomId, energy: "low" },
    );
    expect(s).toMatchObject({ difficulty: "gentle", quiet: true, energy: "low" });
    expect(s.roster).toHaveLength(3);
    const row = w.handle.db.select().from(periods).all()[0]!;
    expect(row).toMatchObject({ kind: "class", energy: "low" });
    await s.close();
  });
});
