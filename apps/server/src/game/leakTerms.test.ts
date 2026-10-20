import { describe, expect, it } from "vitest";
import { untaughtTerms, vocabulary } from "./leakTerms.js";

const taught = vocabulary([
  "Each transaction is hashed, then pairs of hashes are hashed again until one Merkle root is left.",
  "The root goes in the block header.",
  "Merkle Trees",
]);
const source = vocabulary([
  "Bitcoin uses double-SHA256. A merkle path proves inclusion with log2(N) hashes. Lightweight clients use merkleblock messages and bloom filters.",
]);

describe("untaughtTerms", () => {
  it("passes a question built from taught words", () => {
    expect(
      untaughtTerms(
        "Headmaster, if the root is in the header, what happens when a transaction changes?",
        taught,
        source,
        2,
      ),
    ).toEqual({ untaught: [], forceGuard: false });
  });

  it("flags technical tokens and source-only vocabulary the Headmaster never said", () => {
    const r = untaughtTerms(
      "So it uses SHA256 and a merkleblock message, and light clients need log2(N) hashes for inclusion proofs?",
      taught,
      source,
      2,
    );
    expect(r.untaught).toEqual(
      expect.arrayContaining(["sha256", "merkleblock", "log2", "inclusion"]),
    );
    expect(r.forceGuard).toBe(true);
  });

  it("matches simple word forms and ignores capitals at sentence starts", () => {
    expect(
      untaughtTerms("Hashing twice? Pairs again? Roots everywhere!", taught, source, 0).untaught,
    ).toEqual([]);
  });

  it("treats mid-sentence proper nouns as suspicious", () => {
    expect(untaughtTerms("Is this what Satoshi meant?", taught, source, 0).untaught).toEqual([
      "satoshi",
    ]);
  });
});
