import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/load.js";
import { openDb, runMigrations, type DbHandle } from "../../db/client.js";
import { agentOf, fakeDeepSeekFactory } from "../../test-fixtures/fakeDeepSeek.js";
import { UsageMeter } from "../../usage/meter.js";
import { buildUnits, fillGaps } from "./build.js";

const cfg = loadConfig({ env: {} });
const handles: DbHandle[] = [];
afterEach(() => handles.splice(0).forEach((h) => h.close()));

/** A School with one book: a contents page and two real chapters, three passages each. */
function school() {
  const h = openDb(":memory:");
  runMigrations(h);
  handles.push(h);
  const { sqlite } = h;
  sqlite
    .prepare(
      "INSERT INTO schools (id, name, campus_slot, created_at) VALUES ('sch_t', 'Crypto', 0, 'x')",
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO sources (id, school_id, title, kind, status, created_at) VALUES ('src_book', 'sch_t', 'The Book', 'md', 'ready', 'x')",
    )
    .run();
  const chunk = sqlite.prepare(
    "INSERT INTO chunks (id, source_id, ord, text, heading_path, page_from, page_to, token_count) VALUES (?, 'src_book', ?, ?, ?, ?, ?, 100)",
  );
  const text = (topic: string, i: number) => `${topic} passage ${i}. `.repeat(120);
  let ord = 0;
  for (const [chapter, topic] of [
    ["Contents", "contents"],
    ["Hashing", "hash"],
    ["Merkle trees", "merkle"],
  ] as const)
    for (let i = 1; i <= 3; i++) {
      chunk.run(
        `chk_${topic}_${i}`,
        ord,
        text(topic, i),
        `${chapter} > Section ${i}`,
        ord + 1,
        ord + 1,
      );
      ord++;
    }
  return h;
}

/** The fake models: chapters read from the prompt; Merkle trees fails until `merkleOk`. */
function models(h: DbHandle, opts: { merkleOk: () => boolean }) {
  const meter = new UsageMeter({ db: h.db, pricing: cfg.pricing, budget: cfg.models.budget });
  const asked: string[] = [];
  const { factory } = fakeDeepSeekFactory(
    cfg.models,
    (body) => {
      const agent = agentOf(body);
      const prompt = body.messages.map((m) => m.content).join("\n");
      asked.push(agent ?? "?");
      if (agent === "curriculumConnector")
        return JSON.stringify({
          prerequisites: [],
          duplicates: [{ drop: "Hash outputs (dup)", keep: "Hash functions" }],
        });
      const chapter = /Chapter: "([^"]+)"/.exec(prompt)?.[1];
      const ids = [...prompt.matchAll(/\[(chk_[a-z]+_\d)\]/g)].map((m) => m[1]!);
      if (chapter === "Merkle trees" && !opts.merkleOk()) return "this is not json";
      if (chapter === "Hashing")
        return JSON.stringify({
          teachable: true,
          moduleTitle: "Hashing basics",
          goal: "Explain what a hash function does.",
          concepts: [
            {
              title: "Hash functions",
              summary: "A hash maps data to a fixed-size digest.",
              keyFacts: ["A hash has a fixed size.", "Small changes change the hash completely."],
              misconceptions: ["A hash can be reversed."],
              prerequisites: [],
              citations: [ids[0], "chk_made_up"],
              difficulty: 2,
            },
            {
              title: "Hash outputs (dup)",
              summary: "The same idea again.",
              keyFacts: ["Digests are fixed-size.", "They look random."],
              misconceptions: [],
              prerequisites: [],
              citations: [ids[1]],
              difficulty: 2,
            },
          ],
        });
      return JSON.stringify({
        teachable: true,
        moduleTitle: "Merkle trees",
        goal: "Build a Merkle root by hand.",
        concepts: [
          {
            title: "Merkle root",
            summary: "Pairs of hashes are hashed up to one root.",
            keyFacts: ["The root sits in the block header.", "Pairs are hashed together."],
            misconceptions: ["The root is in every transaction."],
            prerequisites: ["Hash functions"],
            citations: [ids[0]],
            difficulty: 3,
          },
        ],
      });
    },
    { meter },
  );
  return { factory, asked };
}

const rows = (h: DbHandle, sql: string) =>
  h.sqlite.prepare(sql).all() as Array<Record<string, unknown>>;

describe("book-by-book curriculum (Paul: big books lost topics)", () => {
  it("reads each chapter, saves the book with its coverage, connects, and fills gaps", async () => {
    const h = school();
    let merkleOk = false;
    const { factory, asked } = models(h, { merkleOk: () => merkleOk });

    const s = await buildUnits({ factory, handle: h }, "sch_t", { rebuild: true });
    // Contents is skipped without asking; Merkle trees failed (bad JSON twice).
    expect(s).toMatchObject({ units: 1, modules: 1, concepts: 1, skipped: 1, failed: 1 });
    expect(asked.filter((a) => a === "chapterAnalyst")).toHaveLength(1 + 2 + 2 - 2); // hashing once, merkle twice (re-ask)
    expect(rows(h, "SELECT title, unit_title u FROM modules")).toEqual([
      { title: "Hashing basics", u: "The Book" },
    ]);
    // The connector merged the duplicate; the made-up citation never got in.
    expect(rows(h, "SELECT title FROM concepts").map((r) => r.title)).toEqual(["Hash functions"]);
    expect(rows(h, "SELECT chunk_id c FROM concept_citations ORDER BY c").map((r) => r.c)).toEqual([
      "chk_hash_1",
      "chk_hash_2",
    ]);
    const unit = JSON.parse(
      (rows(h, "SELECT chapters_json c FROM curriculum_units")[0] as { c: string }).c,
    );
    expect(unit.map((c: { title: string; state: string }) => `${c.title}:${c.state}`)).toEqual([
      "Contents:skipped",
      "Hashing:taught",
      "Merkle trees:failed",
    ]);

    // Fill the gaps: the failed chapter is read again and its module joins the book.
    merkleOk = true;
    const g = await fillGaps({ factory, handle: h }, "sch_t", "src_book");
    expect(g).toEqual({ filled: 1, stillFailed: 0, concepts: 1 });
    expect(rows(h, "SELECT title FROM modules ORDER BY ord").map((r) => r.title)).toEqual([
      "Hashing basics",
      "Merkle trees",
    ]);
    // Its prerequisite title resolved to the earlier chapter's concept.
    const merkle = rows(
      h,
      "SELECT prerequisites_json p FROM concepts WHERE title = 'Merkle root'",
    )[0] as { p: string };
    const hashId = (
      rows(h, "SELECT id FROM concepts WHERE title = 'Hash functions'")[0] as { id: string }
    ).id;
    expect(JSON.parse(merkle.p)).toEqual([hashId]);
    const after = JSON.parse(
      (rows(h, "SELECT chapters_json c FROM curriculum_units")[0] as { c: string }).c,
    );
    expect(after.map((c: { state: string }) => c.state)).toEqual(["skipped", "taught", "taught"]);
  });
});
