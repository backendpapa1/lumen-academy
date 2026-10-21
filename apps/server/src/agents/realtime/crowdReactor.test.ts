import { describe, expect, it } from "vitest";
import { parseReactorLine, reactorMessages } from "./crowdReactor.js";

describe("parseReactorLine", () => {
  it("parses reactions and hands", () => {
    expect(parseReactorLine("3 confused")).toEqual({
      kind: "reaction",
      seat: 3,
      state: "confused",
    });
    expect(parseReactorLine("  - 12 Notetaking ")).toEqual({
      kind: "reaction",
      seat: 12,
      state: "notetaking",
    });
    expect(parseReactorLine('H 2 challenge 0.75 "Why not hash everything at once?"')).toEqual({
      kind: "hand",
      seat: 2,
      intent: "challenge",
      urgency: 0.75,
      preview: "Why not hash everything at once?",
    });
  });

  it("truncates long previews instead of failing", () => {
    const hand = parseReactorLine(`H 1 clarify 1 ${"x".repeat(200)}`);
    expect(hand?.kind === "hand" && hand.preview.length).toBe(80);
  });

  it("rejects malformed lines", () => {
    expect(parseReactorLine("3 sleepy")).toBeNull();
    expect(parseReactorLine("H 2 shout 0.5 hi")).toBeNull();
    expect(parseReactorLine("Here are the reactions:")).toBeNull();
    expect(parseReactorLine('{"reactions": []}')).toBeNull();
  });
});

describe("reactorMessages", () => {
  const base = {
    cards: [],
    conceptTitle: "Merkle Trees",
    transcript: [],
    teacherMessage: "Pairs of hashes are hashed again.",
    maxHands: 3,
  } as unknown as Parameters<typeof reactorMessages>[0];
  const system = (extra: object) => String(reactorMessages({ ...base, ...extra })[0]!.content);

  it("R-6: a class's difficulty sets how sharp the crowd is", () => {
    expect(system({ difficulty: "ruthless" })).toContain("RUTHLESS class");
    expect(system({ difficulty: "gentle" })).toContain("GENTLE class");
    const standard = system({ difficulty: "standard" });
    expect(standard).not.toContain("RUTHLESS");
    expect(standard).not.toContain("GENTLE");
  });
});
