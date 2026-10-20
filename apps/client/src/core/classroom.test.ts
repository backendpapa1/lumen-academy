import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@lumen/shared";
import { applyServerMessage, initialClassroom, type ClassroomState } from "./classroom";

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
    transcript: [],
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
      payload: { periodId: "per_1", turns: 4, minutes: 12, costUsd: 0.01 },
    });
    expect(s).toMatchObject({ status: "ended", ended: { turns: 4 } });
  });
});
