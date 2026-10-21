import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import { arcMoment, arcStep, INITIAL_ARC, isKind, type ArcSignal } from "./arcs.js";

const cfg = loadConfig({ env: {} }).game.arcs;
const run = (archetype: never, signals: ArcSignal[], id = "cdt_1") => {
  let state = { ...INITIAL_ARC };
  const moved: number[] = [];
  for (const s of signals) {
    const r = arcStep({ id, archetype }, state, s, cfg);
    state = r.state;
    if (r.advanced) moved.push(state.stage);
  }
  return { state, moved };
};
const teach = (text: string, replyToCadetId?: string): ArcSignal => ({
  kind: "teach",
  text,
  replyToCadetId,
});

describe("growth arcs (V4-03, VD10)", () => {
  it("the Skeptic warms up after reasons twice in a row, not reasons now and then", () => {
    expect(
      run("skeptic" as never, [
        teach("The root is in the header because it summarises the block."),
        teach("Hashes are short."),
        teach("It changes, which means every later hash changes."),
      ]).moved,
    ).toEqual([]);
    expect(
      run("skeptic" as never, [
        teach("The root is in the header because it summarises the block."),
        teach("So any change shows, which means tampering is caught."),
      ]).moved,
    ).toEqual([1]);
  });

  it("the Quiet One speaks up after being called on three times (only their own calls count)", () => {
    const calls: ArcSignal[] = [
      { kind: "called", cadetId: "cdt_1" },
      { kind: "called", cadetId: "cdt_2" },
      { kind: "called", cadetId: "cdt_1" },
      { kind: "called", cadetId: "cdt_1" },
    ];
    const r = run("quiet" as never, calls);
    expect(r.moved).toEqual([1]);
    expect(arcMoment("quiet", { stage: 2, count: 0 }, "Sora Lee")).toBe(
      "Sora raised a hand for the first time!",
    );
  });

  it("the Lost Signal gains confidence when a misconception of theirs is fixed", () => {
    expect(
      run("lost_signal" as never, [
        { kind: "resolved", cadetId: "cdt_2" },
        { kind: "resolved", cadetId: "cdt_1" },
      ]).moved,
    ).toEqual([1]);
  });

  it("the Saboteur reforms when corrected kindly, not just told they're wrong", () => {
    expect(
      run("saboteur" as never, [teach("No, that's rubbish, the root is in the header.", "cdt_1")])
        .moved,
    ).toEqual([]);
    expect(
      run("saboteur" as never, [
        teach("I see why you'd think that, but it's in the header.", "cdt_2"),
      ]).moved,
    ).toEqual([]);
    expect(
      run("saboteur" as never, [
        teach("I see why you'd think that, but it's in the header.", "cdt_1"),
      ]).moved,
    ).toEqual([1]);
    expect(isKind("Good try! It's actually in the header.")).toBe(true);
  });

  it("stops at the last stage, and archetypes without an arc never change", () => {
    const many = Array.from({ length: 30 }, () => ({ kind: "called", cadetId: "cdt_1" }) as const);
    expect(run("quiet" as never, many).state.stage).toBe(3);
    expect(run("overachiever" as never, many).moved).toEqual([]);
  });
});
