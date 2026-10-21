import { describe, expect, it } from "vitest";
import { isQuestion } from "./modes.js";

describe("Socratic: questions only (V5-02)", () => {
  it("knows a question from a statement", () => {
    for (const q of [
      "What happens if one transaction changes?",
      "Why would you pair them",
      "So, how does the header know about the transactions",
      "Suppose there are five transactions. Then what",
      "Walk me through it",
    ])
      expect([q, isQuestion(q)]).toEqual([q, true]);
    for (const s of [
      "The root goes in the header.",
      "Hashes are paired up to a root",
      "Now the next idea is the nonce.",
    ])
      expect([s, isQuestion(s)]).toEqual([s, false]);
  });
});
