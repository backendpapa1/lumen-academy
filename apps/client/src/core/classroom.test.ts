import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@lumen/shared";
import { applyServerMessage, elapsedMs, initialClassroom, type ClassroomState } from "./classroom";

const started: ServerMessage = {
  type: "period.started",
  payload: {
    periodId: "per_1",
    school: { id: "sch_1", name: "Blockchain" },
    classroom: { id: "cls_1", name: "Class A" },
    concept: { id: "cpt_1", title: "Merkle Trees" },
    concepts: [{ id: "cpt_1", title: "Merkle Trees" }],
    cadets: [
      {
        id: "c1",
        name: "Ines",
        archetype: "skeptic",
        seat: 3,
        homeworld: "Titan",
        quirk: "q",
        comprehension: 0,
        state: "attentive",
      },
      {
        id: "c2",
        name: "Tomas",
        archetype: "lost_signal",
        seat: 7,
        homeworld: "Ceres",
        quirk: "q",
        comprehension: 0,
        state: "attentive",
      },
    ],
    plannedMinutes: 15,
    elapsedMs: 0,
    resumed: false,
    paused: false,
    transcript: [],
    xp: {
      total: 340,
      rank: "Cadet Instructor",
      next: { name: "Lecturer", minXp: 500 },
      progress: 0.68,
    },
  },
};
const run = (msgs: ServerMessage[], s: ClassroomState = initialClassroom(), now = 1000) =>
  msgs.reduce((acc, m) => applyServerMessage(acc, m, now), s);

describe("applyServerMessage", () => {
  it("starts a live period with cadets keyed by id", () => {
    const s = run([started]);
    expect(s.status).toBe("live");
    expect(Object.keys(s.cadets)).toEqual(["c1", "c2"]);
  });

  it("runs the teaching clock from the server's elapsed time, frozen while paused", () => {
    let s = run([started], initialClassroom(), 1000);
    expect(elapsedMs(s, 61_000)).toBe(60_000);
    s = applyServerMessage(
      s,
      { type: "period.paused", payload: { paused: true, elapsedMs: 60_000 } },
      61_000,
    );
    expect(elapsedMs(s, 500_000)).toBe(60_000);
    s = applyServerMessage(
      s,
      { type: "period.paused", payload: { paused: false, elapsedMs: 60_000 } },
      500_000,
    );
    expect(elapsedMs(s, 530_000)).toBe(90_000);
  });

  it("takes XP gains live", () => {
    const s = run([
      started,
      {
        type: "xp.update",
        payload: {
          delta: 15,
          reason: "Answered a question",
          standing: {
            total: 355,
            rank: "Cadet Instructor",
            next: { name: "Lecturer", minXp: 500 },
            progress: 0.71,
          },
        },
      },
    ]);
    expect(s.xp?.total).toBe(355);
    expect(s.xpGain).toMatchObject({ delta: 15, reason: "Answered a question" });
  });

  it("restores a resumed period's transcript and clock", () => {
    if (started.type !== "period.started") throw new Error();
    const s = run([
      {
        ...started,
        payload: {
          ...started.payload,
          elapsedMs: 240_000,
          resumed: true,
          paused: true,
          transcript: [
            { speaker: "Headmaster", messageId: "m1", text: "Hashes pair up." },
            { speaker: "Ines", cadetId: "c1", messageId: "m2", text: "Why pairs?" },
          ],
        },
      },
    ]);
    expect(s.resumed).toBe(true);
    expect(elapsedMs(s, 999_999)).toBe(240_000);
    expect(s.transcript).toEqual([
      { speaker: "headmaster", cadetId: undefined, messageId: "m1", text: "Hashes pair up." },
      { speaker: "cadet", cadetId: "c1", messageId: "m2", text: "Why pairs?" },
    ]);
  });

  it("applies reactions, measures time to first reaction, and updates comprehension", () => {
    let s: ClassroomState = { ...run([started]), lastSendAt: 400 };
    s = applyServerMessage(s, { type: "turn.started", payload: { turnId: "t1", text: "hi" } }, 500);
    expect(s.thinking).toBe(true);
    s = applyServerMessage(
      s,
      { type: "crowd.reaction", payload: { turnId: "t1", cadetId: "c2", state: "confused" } },
      1300,
    );
    s = applyServerMessage(
      s,
      { type: "crowd.reaction", payload: { turnId: "t1", cadetId: "c1", state: "skeptical" } },
      1600,
    );
    expect(s.lastReactionMs).toBe(900);
    expect(s.cadets.c2!.state).toBe("confused");
    s = applyServerMessage(s, {
      type: "ledger.update",
      payload: {
        turnId: "t1",
        conceptId: "cpt_1",
        cadets: [{ cadetId: "c1", comprehension: 0.3 }],
        classAverage: 0.2,
      },
    });
    expect(s.cadets.c1!.comprehension).toBe(0.3);
    expect(s.classAverage).toBe(0.2);
  });

  it("assembles streamed speech, records it, and swaps in a rewrite", () => {
    const s = run([
      started,
      { type: "cadet.stream", payload: { cadetId: "c1", streamId: "s1", delta: "Where is " } },
      { type: "cadet.stream", payload: { cadetId: "c1", streamId: "s1", delta: "the root?" } },
    ]);
    expect(s.speech).toMatchObject({ text: "Where is the root?", done: false });
    const done = run(
      [
        {
          type: "cadet.done",
          payload: {
            cadetId: "c1",
            streamId: "s1",
            messageId: "m1",
            text: "Where is the root?",
            kind: "question",
            mood: "curious",
          },
        },
      ],
      s,
    );
    expect(done.transcript.at(-1)).toMatchObject({ speaker: "cadet", messageId: "m1" });
    const rewritten = applyServerMessage(
      done,
      {
        type: "cadet.rewrite",
        payload: { messageId: "m1", cadetId: "c1", text: "Where does it go?" },
      },
      5000,
    );
    expect(rewritten.speech).toMatchObject({ text: "Where does it go?", rephrasedAt: 5000 });
    expect(rewritten.transcript.at(-1)!.text).toBe("Where does it go?");
  });

  it("drops an interrupted speech and keeps at most 3 toasts", () => {
    let s = run([
      started,
      { type: "cadet.stream", payload: { cadetId: "c1", streamId: "s1", delta: "Wa" } },
      { type: "cadet.interrupted", payload: { cadetId: "c1", streamId: "s1" } },
    ]);
    expect(s.speech).toBeNull();
    for (let i = 0; i < 5; i++)
      s = applyServerMessage(s, { type: "toast", payload: { level: "info", text: `t${i}` } });
    expect(s.toasts.map((t) => t.text)).toEqual(["t2", "t3", "t4"]);
  });

  it("ignores ledger updates for another concept, and ends the period", () => {
    let s = run([
      started,
      {
        type: "ledger.update",
        payload: {
          turnId: "t",
          conceptId: "cpt_other",
          cadets: [{ cadetId: "c1", comprehension: 0.9 }],
          classAverage: 0.9,
        },
      },
    ]);
    expect(s.cadets.c1!.comprehension).toBe(0);
    s = applyServerMessage(s, {
      type: "period.ended",
      payload: {
        periodId: "per_1",
        turns: 4,
        minutes: 12,
        costUsd: 0.01,
        xp: {
          earned: 150,
          breakdown: [{ kind: "teachingMinute", amount: 120 }],
          standing: { total: 520, rank: "Lecturer", next: null, progress: 1 },
          rankedUp: true,
        },
      },
    });
    expect(s).toMatchObject({ status: "ended", ended: { turns: 4, xp: { earned: 150 } } });
    expect(s.xp?.rank).toBe("Lecturer");
  });
});
