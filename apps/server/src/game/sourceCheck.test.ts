import { afterEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { BowEmbedder } from "../test-fixtures/bowEmbedder.js";
import { smallWorld } from "../test-fixtures/world.js";
import { checkSource, OPEN_BOOK_MS, peekedRecently } from "./sourceCheck.js";

let h: DbHandle | undefined;
afterEach(() => h?.close());

describe("/source (V6-06)", () => {
  it("finds my sources' passage for what I said, logs the look, and an hour later it's closed-book again", async () => {
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    h = w.handle;
    expect(peekedRecently(h, w.schoolId)).toBe(false);
    const p = await checkSource(
      { handle: h, embedder: new BowEmbedder() },
      {
        schoolId: w.schoolId,
        periodId: null,
        query: "where is the merkle root kept in the header",
      },
    );
    expect(p?.text.length).toBeGreaterThan(0);
    expect(p?.source).toBeTruthy();
    expect(peekedRecently(h, w.schoolId)).toBe(true);
    expect(peekedRecently(h, w.schoolId, Date.now() + OPEN_BOOK_MS + 1000)).toBe(false);
  });
});
