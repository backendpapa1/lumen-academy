import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import { openDb, runMigrations, type DbHandle } from "../db/client.js";
import { hybridSearch } from "../retrieval/search.js";
import { BowEmbedder } from "../test-fixtures/bowEmbedder.js";
import { smallWorld } from "../test-fixtures/world.js";
import { exportSchool, importSchool } from "./exportImport.js";
import { yearbookMarkdown } from "./yearbook.js";

const cfg = loadConfig({ env: {} });
const handles: DbHandle[] = [];
afterEach(() => handles.splice(0).forEach((h) => h.close()));

const count = (h: DbHandle, t: string) =>
  (h.sqlite.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;

describe("School export/import (O-5)", () => {
  it("round-trips a School into an empty campus: rows, embeddings and search", async () => {
    const w = await smallWorld([
      { attention: 0.6, skepticism: 0.4 },
      { attention: 0.5, skepticism: 0.5 },
    ]);
    handles.push(w.handle);
    w.handle.sqlite
      .prepare(
        "INSERT INTO ledger_entries (cadet_id, concept_id, comprehension, exposures, misconceptions_json) VALUES (?, ?, 0.5, 3, '[]')",
      )
      .run(w.cadets[0]!.id, w.conceptIds[0]);
    const dir = mkdtempSync(join(tmpdir(), "lumen-exp-"));
    const { filename, zip } = exportSchool(w.handle, cfg.game, {
      schoolId: w.schoolId,
      generatedDir: join(dir, "generated"),
    });
    expect(filename).toBe("school-blockchain.zip");

    const fresh = openDb(":memory:");
    runMigrations(fresh);
    handles.push(fresh);
    const r = importSchool(fresh, { zip, dataDir: dir, generatedDir: join(dir, "generated") });
    expect(r).toMatchObject({ schoolId: w.schoolId, name: "Blockchain" });
    for (const t of [
      "schools",
      "sources",
      "chunks",
      "modules",
      "concepts",
      "concept_citations",
      "classrooms",
      "cadets",
      "ledger_entries",
    ])
      expect([t, count(fresh, t)]).toEqual([t, count(w.handle, t)]);
    expect(count(fresh, "chunk_vec")).toBe(count(w.handle, "chunk_vec"));
    // Search works on the imported School without re-embedding (FTS triggers + vectors).
    const hits = await hybridSearch(
      { handle: fresh, embedder: new BowEmbedder() },
      { schoolId: w.schoolId, query: "root header", k: 2 },
    );
    expect(hits.length).toBeGreaterThan(0);
    // Importing twice is refused.
    expect(() =>
      importSchool(fresh, { zip, dataDir: dir, generatedDir: join(dir, "generated") }),
    ).toThrow(/already/);
  });

  it("still imports a version 1 export (before V2's tables and columns)", async () => {
    const w = await smallWorld([{ attention: 0.6, skepticism: 0.4 }]);
    handles.push(w.handle);
    w.handle.sqlite
      .prepare(
        "INSERT INTO ledger_entries (cadet_id, concept_id, comprehension, exposures, misconceptions_json) VALUES (?, ?, 0.5, 3, '[]')",
      )
      .run(w.cadets[0]!.id, w.conceptIds[0]);
    const dir = mkdtempSync(join(tmpdir(), "lumen-exp-"));
    const { zip } = exportSchool(w.handle, cfg.game, {
      schoolId: w.schoolId,
      generatedDir: join(dir, "generated"),
    });
    const files = unzipSync(zip);
    const path = Object.keys(files).find((f) => f.endsWith("school.json"))!;
    const bundle = JSON.parse(strFromU8(files[path]!));
    bundle.version = 1;
    delete bundle.tables.speech_corrections;
    delete bundle.tables.self_ratings;
    for (const row of bundle.tables.ledger_entries ?? []) delete row.stability_days;
    files[path] = strToU8(JSON.stringify(bundle));

    const fresh = openDb(":memory:");
    runMigrations(fresh);
    handles.push(fresh);
    importSchool(fresh, {
      zip: zipSync(files),
      dataDir: dir,
      generatedDir: join(dir, "generated"),
    });
    expect(count(fresh, "ledger_entries")).toBe(1);
  });

  it("refuses a zip that isn't an export", () => {
    const h = openDb(":memory:");
    runMigrations(h);
    handles.push(h);
    expect(() =>
      importSchool(h, {
        zip: new Uint8Array([80, 75, 5, 6, ...new Array(18).fill(0)]),
        dataDir: tmpdir(),
        generatedDir: tmpdir(),
      }),
    ).toThrow(/school\.json/);
  });
});

describe("Yearbook (P-6)", () => {
  it("lists every concept with its key facts, ticks what was covered, and shows corrections", async () => {
    const w = await smallWorld([{ attention: 0.6, skepticism: 0.4 }]);
    handles.push(w.handle);
    const h = w.handle;
    h.sqlite
      .prepare(
        "INSERT INTO periods (id, classroom_id, started_at, planned_minutes) VALUES ('per_1', ?, '2026-10-21', 15)",
      )
      .run(w.classroomId);
    h.sqlite
      .prepare(
        "INSERT INTO messages (id, period_id, speaker, kind, text, concept_id, created_at) VALUES ('msg_1','per_1','teacher','lecture','Pairs are hashed to a root.', ?, '2026-10-21')",
      )
      .run(w.conceptIds[0]);
    h.sqlite
      .prepare(
        "INSERT INTO turns (id, period_id, ord, teacher_message_id, analysis_json, reactions_json, created_at) VALUES ('trn_1','per_1',1,'msg_1',?, '{}', '2026-10-21')",
      )
      .run(
        JSON.stringify({
          conceptIds: [w.conceptIds[0]],
          teaching: { accuracy: 0.6, clarity: 1, coverage: ["Merkle Trees a"], errors: [] },
          ledgerDeltas: [],
        }),
      );
    h.sqlite
      .prepare(
        "INSERT INTO teacher_errors (id, turn_id, concept_id, claim, correction) VALUES ('ter_1','trn_1',?, 'The root is in every transaction.', 'Only in the header.')",
      )
      .run(w.conceptIds[0]);
    const md = yearbookMarkdown(h, cfg.game, w.schoolId);
    expect(md).toContain("# Blockchain: Yearbook");
    expect(md).toContain("### Merkle Trees");
    expect(md).toContain("- [x] Merkle Trees a");
    expect(md).toContain("- [ ] Merkle Trees b");
    expect(md).toContain("> Pairs are hashed to a root.");
    expect(md).toContain("~~The root is in every transaction.~~ → Only in the header.");
  });
});
