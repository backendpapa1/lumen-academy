import { afterEach, describe, expect, it } from "vitest";
import { normalizeTeachingAnalysis } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { smallWorld } from "../test-fixtures/world.js";
import { pinDefinitions, wallTerms } from "./glossaryWall.js";

let h: DbHandle | undefined;
afterEach(() => h?.close());

describe("glossary wall (V6-08)", () => {
  it("pins my definitions, replaces a re-definition, and marks ones that disagree with the sources", async () => {
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    h = w.handle;
    const pin = (definitions: Parameters<typeof pinDefinitions>[1]["definitions"]) =>
      pinDefinitions(h!, {
        schoolId: w.schoolId,
        periodId: "per_1",
        conceptId: w.conceptIds[0]!,
        definitions,
      });
    pin([
      { term: "Merkle Root", definition: "One hash that sums up every transaction.", agrees: true },
    ]);
    pin([
      {
        term: "nonce",
        definition: "A number stored in each transaction.",
        agrees: false,
        note: "It's in the header.",
      },
    ]);
    pin([
      { term: "merkle  root", definition: "The single hash at the top of the tree.", agrees: true },
    ]);
    const wall = wallTerms(h, w.schoolId);
    expect(wall).toHaveLength(2);
    expect(wall.find((t) => t.term === "merkle root")?.definition).toBe(
      "The single hash at the top of the tree.",
    );
    expect(wall.find((t) => t.term === "nonce")).toMatchObject({
      agrees: false,
      note: "It's in the header.",
    });
  });

  it("the Director's definitions survive normalisation (at most three)", () => {
    const a = normalizeTeachingAnalysis({
      conceptIds: [],
      teaching: { accuracy: 1, clarity: 1, coverage: [], errors: [] },
      ledgerDeltas: [],
      definitions: [1, 2, 3, 4].map((i) => ({ term: `t${i}`, definition: "d", agrees: true })),
    });
    expect(a.definitions).toHaveLength(3);
  });
});
