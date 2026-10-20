import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceTools } from "../agents/tools/source.js";
import { openDb, runMigrations, type DbHandle } from "../db/client.js";
import { ensureSchool, ingestSource } from "../ingest/pipeline.js";
import { BowEmbedder } from "../test-fixtures/bowEmbedder.js";
import { ftsQuery, hybridSearch } from "./search.js";

const FIXTURE = join(import.meta.dirname, "../../../../fixtures/blockchain-ch1/source.md");
// Fixture queries → the section that must appear in the top 5 (M1-03 criterion).
const RETRIEVAL_CASES = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../../fixtures/blockchain-ch1/retrieval-cases.json"),
      "utf8",
    ),
  ) as { cases: Array<{ query: string; heading: string; semanticOnly?: boolean }> }
).cases
  .filter((c) => !c.semanticOnly) // bag-of-words can't match paraphrases
  .map((c) => [c.query, c.heading] as [string, string]);

let h: DbHandle;
let schoolId: string;
let otherSchool: string;
const embedder = new BowEmbedder();

beforeAll(async () => {
  h = openDb(":memory:");
  runMigrations(h);
  const dataDir = mkdtempSync(join(tmpdir(), "lumen-search-"));
  schoolId = ensureSchool(h, "Blockchain").id;
  otherSchool = ensureSchool(h, "Philosophy").id;
  await ingestSource(
    { handle: h, embedder, dataDir },
    { schoolId, title: "ch11", kind: "md", data: readFileSync(FIXTURE, "utf8") },
  );
  await ingestSource(
    { handle: h, embedder, dataDir },
    {
      schoolId: otherSchool,
      title: "other",
      kind: "paste",
      data: "Merkle root merkle root merkle root in the block header of a different school.",
    },
  );
});
afterAll(() => h.close());

describe("ftsQuery", () => {
  it("quotes terms and survives punctuation", () => {
    expect(ftsQuery(`what's "merkle" OR root?`)).toBe(`"what" OR "merkle" OR "or" OR "root"`);
    expect(ftsQuery("?!")).toBeNull();
  });
});

describe("hybridSearch (offline bag-of-words embeddings)", () => {
  it.each(RETRIEVAL_CASES)("%s → %s in top 5", async (query, heading) => {
    const hits = await hybridSearch({ handle: h, embedder }, { query, schoolId, k: 5 });
    expect(hits.map((x) => x.headingPath ?? "").some((p) => p.endsWith(heading))).toBe(true);
  });

  it("only returns the requested school's chunks, scored and sorted", async () => {
    const hits = await hybridSearch(
      { handle: h, embedder },
      { query: "merkle root block header", schoolId: otherSchool, k: 5 },
    );
    expect(hits).toHaveLength(1);
    const main = await hybridSearch(
      { handle: h, embedder },
      { query: "merkle root block header", schoolId, k: 8 },
    );
    expect(main.every((x) => !x.text.includes("different school"))).toBe(true);
    expect(main.map((x) => x.score)).toEqual([...main.map((x) => x.score)].sort((a, b) => b - a));
    for (const x of main) expect(x.score).toBeCloseTo(0.6 * x.cosine + 0.4 * x.bm25);
  });

  it("never returns two overlapping (adjacent, same-section) chunks", async () => {
    const hits = await hybridSearch(
      { handle: h, embedder },
      { query: "merkle tree hash pairs root", schoolId, k: 10 },
    );
    for (const a of hits)
      for (const b of hits)
        if (a !== b && a.sourceId === b.sourceId && a.headingPath === b.headingPath)
          expect(Math.abs(a.ord - b.ord)).not.toBe(1);
  });

  it("keeps adjacent chunks from different sections (they don't overlap)", async () => {
    const hits = await hybridSearch(
      { handle: h, embedder },
      { query: "fields in the 80 byte block header", schoolId, k: 5 },
    );
    const paths = hits.map((x) => x.headingPath);
    expect(paths).toContain("The Blockchain > Structure of a Block");
    expect(paths).toContain("The Blockchain > Block Header");
  });
});

describe("source tools", () => {
  it("search → read → outline, scoped to the school", async () => {
    const tools = sourceTools({ handle: h, embedder, schoolId });
    const found = String(await tools.searchSource.invoke({ query: "genesis block", k: 3 }));
    const id = /\[(chk_[0-9a-z]+)\]/.exec(found)?.[1];
    expect(id).toBeDefined();
    expect(String(await tools.readChunks.invoke({ ids: [id!] }))).toContain(`[${id}]`);
    const sourceId = h.sqlite
      .prepare("SELECT id FROM sources WHERE school_id = ?")
      .get(schoolId) as { id: string };
    const outline = String(await tools.getSourceOutline.invoke({ sourceId: sourceId.id }));
    expect(outline).toContain("- Merkle Trees");
    expect(outline).toMatch(/Chunks \(\d+\)/);

    const other = sourceTools({ handle: h, embedder, schoolId: otherSchool });
    expect(String(await other.readChunks.invoke({ ids: [id!] }))).toBe(
      "No chunks with those ids in this School.",
    );
  });
});
