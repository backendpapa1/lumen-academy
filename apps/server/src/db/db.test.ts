import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, runMigrations, type DbHandle } from "./client.js";
import { idKind, newId } from "./ids.js";
import { chunks, schools, sources } from "./schema.js";

const EXPECTED_TABLES = [
  "schools",
  "sources",
  "chunks",
  "modules",
  "concepts",
  "concept_citations",
  "classrooms",
  "cadets",
  "ledger_entries",
  "periods",
  "turns",
  "messages",
  "exit_tickets",
  "assignments",
  "submissions",
  "exams",
  "exam_questions",
  "exam_results",
  "debriefs",
  "teacher_errors",
  "assets",
  "usage_log",
  "xp_events",
  "leak_events",
  "settings",
  "chunk_vec",
  "message_vec",
  "chunk_fts",
];

const now = () => new Date().toISOString();

function vec(...head: number[]): Float32Array {
  const v = new Float32Array(1536);
  head.forEach((x, i) => (v[i] = x));
  return v;
}

describe("database", () => {
  let h: DbHandle;

  beforeEach(() => {
    h = openDb(":memory:");
    runMigrations(h);
  });
  afterEach(() => h.close());

  it("creates every table from the data model plus D5 additions", () => {
    const names = (
      h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const t of EXPECTED_TABLES) expect(names, t).toContain(t);

    const turnCols = (h.sqlite.pragma("table_info(turns)") as { name: string }[]).map(
      (c) => c.name,
    );
    expect(turnCols).toEqual(expect.arrayContaining(["reactions_json", "low_confidence"]));
  });

  it("is idempotent", () => {
    expect(() => runMigrations(h)).not.toThrow();
  });

  it("enforces foreign keys", () => {
    expect(() =>
      h.db
        .insert(sources)
        .values({
          id: newId("source"),
          schoolId: "sch_missing",
          title: "x",
          kind: "txt",
          status: "queued",
          createdAt: now(),
        })
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("keeps chunk_fts in sync with chunks", () => {
    const schoolId = newId("school");
    const sourceId = newId("source");
    h.db
      .insert(schools)
      .values({ id: schoolId, name: "Blockchain", campusSlot: 0, createdAt: now() })
      .run();
    h.db
      .insert(sources)
      .values({
        id: sourceId,
        schoolId,
        title: "ch1",
        kind: "txt",
        status: "ready",
        createdAt: now(),
      })
      .run();
    const chunkId = newId("chunk");
    h.db
      .insert(chunks)
      .values({
        id: chunkId,
        sourceId,
        ord: 0,
        text: "A Merkle root summarises every transaction",
        tokenCount: 7,
      })
      .run();

    const hits = () =>
      h.sqlite
        .prepare(
          "SELECT c.id FROM chunk_fts f JOIN chunks c ON c.rowid = f.rowid WHERE chunk_fts MATCH ?",
        )
        .all("merkle") as { id: string }[];
    expect(hits().map((r) => r.id)).toEqual([chunkId]);

    h.sqlite.prepare("UPDATE chunks SET text = 'proof of stake' WHERE id = ?").run(chunkId);
    expect(hits()).toEqual([]);
    h.sqlite.prepare("DELETE FROM chunks WHERE id = ?").run(chunkId);
    expect(
      h.sqlite.prepare("SELECT count(*) n FROM chunk_fts WHERE chunk_fts MATCH 'stake'").get(),
    ).toEqual({ n: 0 });
  });

  it("stores 1536-d embeddings and returns cosine KNN by chunk id", () => {
    const insert = h.sqlite.prepare("INSERT INTO chunk_vec (chunk_id, embedding) VALUES (?, ?)");
    insert.run("chk_a", vec(1, 0));
    insert.run("chk_b", vec(0, 1));
    insert.run("chk_c", vec(1, 1));
    const rows = h.sqlite
      .prepare(
        "SELECT chunk_id, distance FROM chunk_vec WHERE embedding MATCH ? AND k = 3 ORDER BY distance",
      )
      .all(vec(2, 0)) as { chunk_id: string; distance: number }[];
    expect(rows.map((r) => r.chunk_id)).toEqual(["chk_a", "chk_c", "chk_b"]);
    expect(rows[0]?.distance).toBeCloseTo(0, 5); // cosine: magnitude-independent
    expect(rows[2]?.distance).toBeCloseTo(1, 5);
  });
});

describe("ids", () => {
  it("prefixes ULIDs and round-trips the kind", () => {
    const id = newId("cadet");
    expect(id).toMatch(/^cdt_[0-9a-z]{26}$/);
    expect(idKind(id)).toBe("cadet");
    expect(idKind("zzz_123")).toBeUndefined();
  });

  it("sorts by creation time", () => {
    const a = newId("message", 1_000);
    const b = newId("message", 2_000);
    expect(a < b).toBe(true);
  });
});
