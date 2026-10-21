import { describe, expect, it } from "vitest";
import { chunkLine, nextChunkEnd } from "./speech.js";

describe("speech chunking", () => {
  it("cuts the first chunk at the first comma, then by sentence", () => {
    expect(
      chunkLine(
        "Wait, so if one old block changes, its hash changes too. Then every later block breaks?",
      ),
    ).toEqual([
      "Wait,",
      "so if one old block changes, its hash changes too.",
      "Then every later block breaks?",
    ]);
  });

  it("cuts a long first clause after a few words", () => {
    expect(chunkLine("I really do not see why the header needs a nonce at all.")[0]).toBe(
      "I really do not see why",
    );
  });

  it("waits for more text until a boundary is certain", () => {
    expect(nextChunkEnd("Wait", 0, false)).toBeNull();
    expect(nextChunkEnd("Wait,", 0, false)).toBeNull(); // could be "Wait,5"
    expect(nextChunkEnd("Wait, so", 0, false)).toBe(5);
    expect(nextChunkEnd("Hm. Wait", 0, false)).toBe(3);
    expect(nextChunkEnd("Wait, so", 5, false)).toBeNull();
    expect(nextChunkEnd("Wait, so", 5, true)).toBe(8);
  });

  it("doesn't cut decimals or abbreviations mid-token", () => {
    expect(chunkLine("It costs 0.5 coins. Then it doubles.")).toEqual([
      "It costs 0.5 coins.",
      "Then it doubles.",
    ]);
  });

  it("never returns empty chunks", () => {
    expect(chunkLine("   ")).toEqual([]);
    expect(chunkLine("Okay!")).toEqual(["Okay!"]);
  });
});

describe("learning my mishearings", () => {
  it("finds short word swaps", async () => {
    const { wordSwaps } = await import("./speech.js");
    expect(
      wordSwaps(
        "The ash of the previous block's edda.",
        "The hash of the previous block's header.",
      ),
    ).toEqual([
      { heard: "ash", meant: "hash" },
      { heard: "edda", meant: "header" },
    ]);
    expect(
      wordSwaps("The market route lives in the header", "The Merkle root lives in the header"),
    ).toEqual([{ heard: "market route", meant: "Merkle root" }]);
  });

  it("ignores rewrites, punctuation and case", async () => {
    const { wordSwaps } = await import("./speech.js");
    expect(wordSwaps("Hashes are paired.", "hashes are paired")).toEqual([]);
    expect(
      wordSwaps(
        "Hashes are paired and joined.",
        "Let me say this differently: roots summarise blocks.",
      ),
    ).toEqual([]);
  });
});
