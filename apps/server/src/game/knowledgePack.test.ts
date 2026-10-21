import { describe, expect, it } from "vitest";
import { asTaughtSentence, formatPack, knowledgePack, type PackInput } from "./knowledgePack.js";

const facts = ["f1", "f2", "f3", "f4", "f5"];
const input = (over: Partial<PackInput> = {}): PackInput => ({
  conceptTitle: "Merkle Trees",
  taught: facts.map((fact) => ({ fact, timesCovered: 1 })),
  comprehension: 0.6,
  misconceptions: [],
  seed: { cadetId: "cdt_1", conceptId: "cpt_1", purpose: "exam" },
  ...over,
});

describe("knowledgePack", () => {
  it("retains round(comprehension × taught) facts", () => {
    expect(knowledgePack(input({ comprehension: 0 })).retained).toEqual([]);
    expect(knowledgePack(input({ comprehension: 0.6 })).retained).toHaveLength(3);
    expect(knowledgePack(input({ comprehension: 1 })).retained.sort()).toEqual(facts);
    expect(knowledgePack(input({ comprehension: 0.6 })).forgotten).toBe(2);
  });

  it("only draws from facts that were actually taught", () => {
    const pack = knowledgePack(
      input({
        comprehension: 1,
        taught: [
          { fact: "a", timesCovered: 2 },
          { fact: "b", timesCovered: 0 },
        ],
      }),
    );
    expect(pack.retained).toEqual(["a"]);
  });

  it("is deterministic per seed and varies across cadets", () => {
    expect(knowledgePack(input()).retained).toEqual(knowledgePack(input()).retained);
    const picks = new Set(
      Array.from({ length: 30 }, (_, i) =>
        knowledgePack(input({ seed: { cadetId: `c${i}`, conceptId: "cpt_1", purpose: "exam" } }))
          .retained.sort()
          .join(),
      ),
    );
    expect(picks.size).toBeGreaterThan(3);
  });

  it("favours facts covered more often", () => {
    let heavy = 0;
    for (let i = 0; i < 500; i++) {
      const pack = knowledgePack(
        input({
          comprehension: 0.2, // 1 of 5
          taught: facts.map((fact, j) => ({ fact, timesCovered: j === 0 ? 8 : 1 })),
          seed: { cadetId: `c${i}`, conceptId: "cpt_1", purpose: "exam" },
        }),
      );
      if (pack.retained[0] === "f1") heavy++;
    }
    expect(heavy / 500).toBeGreaterThan(0.55); // 8 / 12 ≈ 0.67
  });

  it("formats misconceptions as confident beliefs and empty packs explicitly", () => {
    const text = formatPack([
      knowledgePack(input({ comprehension: 0, misconceptions: ["root is in every tx"] })),
    ]);
    expect(text).toContain("you remember nothing specific");
    expect(text).toContain("You also believe (and are sure of):\n- root is in every tx");
  });
});

describe("retained facts are the teacher's words (knowledge gating)", () => {
  it("never hands a cadet the source's detail for a fact the teacher only gisted", () => {
    const fact =
      "To build a parent node, the two 32-byte child hashes are concatenated into a 64-byte string which is then double-hashed.";
    const pack = knowledgePack({
      conceptTitle: "Merkle tree construction",
      taught: [
        {
          fact,
          timesCovered: 1,
          asTaught: [
            "Picture a tournament bracket. Each transaction is hashed. Then neighbouring hashes are paired, joined together and hashed again.",
          ],
        },
      ],
      comprehension: 1,
      misconceptions: [],
      seed: { cadetId: "c", conceptId: "k", purpose: "t" },
    });
    expect(pack.retained).toEqual([
      "Then neighbouring hashes are paired, joined together and hashed again.",
    ]);
    expect(pack.retained.join(" ")).not.toMatch(/32-byte|64-byte/);
  });

  it("picks the teacher's sentence closest to the fact", () => {
    expect(
      asTaughtSentence(
        ["Hi all. The root goes in the header. Change any transaction and the root changes."],
        "The Merkle root is stored in the block header.",
      ),
    ).toBe("The root goes in the header.");
  });
});
