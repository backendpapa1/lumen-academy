import { describe, expect, it } from "vitest";
import { parseReactorLine } from "./crowdReactor.js";

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
