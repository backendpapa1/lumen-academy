import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { fakeDeepSeekFactory } from "../test-fixtures/fakeDeepSeek.js";
import { BowEmbedder } from "../test-fixtures/bowEmbedder.js";
import { smallWorld } from "../test-fixtures/world.js";
import { askGuest, guestsLeft } from "./guest.js";
import { cadetPack } from "./packs.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());

describe("guest lecturer (V5-09)", () => {
  it("answers from my sources with real citations, is capped, and never reaches a student", async () => {
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    h = w.handle;
    const chunk = (h.sqlite.prepare("SELECT id FROM chunks LIMIT 1").get() as { id: string }).id;
    const { factory } = fakeDeepSeekFactory(cfg.models, () =>
      JSON.stringify({
        answer: "Think of the root as a fingerprint of the header's transactions.",
        citations: [chunk, "chk_made_up"],
      }),
    );
    h.sqlite
      .prepare(
        "INSERT INTO periods (id, classroom_id, started_at, planned_minutes) VALUES ('per_g', ?, ?, 15)",
      )
      .run(w.classroomId, new Date().toISOString());
    const before = guestsLeft(h, cfg.game);
    const g = await askGuest(
      { handle: h, factory, embedder: new BowEmbedder() },
      {
        schoolId: w.schoolId,
        schoolName: "Blockchain",
        periodId: "per_g",
        question: "Where is the root kept?",
      },
    );
    expect(g.citations).toHaveLength(1); // the made-up id is dropped
    expect(guestsLeft(h, cfg.game)).toBe(before - 1);
    const pack = cadetPack(h, {
      classroomId: w.classroomId,
      cadetId: w.cadets[0]!.id,
      concept: {
        id: w.conceptIds[0]!,
        title: "Merkle Trees",
        keyFacts: ["The root is in the header."],
      },
      purpose: "test",
    });
    expect(JSON.stringify(pack)).not.toContain("fingerprint");
  });
});
