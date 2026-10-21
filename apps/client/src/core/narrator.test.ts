import { describe, expect, it } from "vitest";
import { sentences } from "./narrator";

describe("narrator sentences", () => {
  it("splits a line into sentences, joining very short ones", () => {
    expect(
      sentences(
        "Hello, I'm Ms Hale, Head of Lumen Academy. Here you teach a class of AI students. Ready? Let's go.",
      ),
    ).toEqual([
      "Hello, I'm Ms Hale, Head of Lumen Academy.",
      "Here you teach a class of AI students.",
      "Ready? Let's go.",
    ]);
  });

  it("keeps a line without a full stop whole", () => {
    expect(sentences("Press Tab to pick the hand")).toEqual(["Press Tab to pick the hand"]);
  });
});
