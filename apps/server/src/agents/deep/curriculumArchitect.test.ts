import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Curriculum } from "@lumen/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, runMigrations, type DbHandle } from "../../db/client.js";
import { saveCurriculum } from "../../db/curriculum.js";
import { newId } from "../../db/ids.js";
import {
  cadets,
  classrooms,
  concepts,
  conceptCitations,
  ledgerEntries,
  modules,
} from "../../db/schema.js";
import { ensureSchool, ingestSource } from "../../ingest/pipeline.js";
import { BowEmbedder } from "../../test-fixtures/bowEmbedder.js";
import { checkCurriculum } from "./curriculumArchitect.js";

const concept = (title: string, citations: string[], prerequisites: string[] = []) => ({
  title,
  summary: `${title} summary`,
  keyFacts: ["fact one", "fact two"],
  misconceptions: ["wrong one"],
  prerequisites,
  citations,
  difficulty: 2.6,
});

describe("checkCurriculum", () => {
  const valid = new Set(["chk_a", "chk_b"]);
  const json = (c: unknown) => JSON.stringify(c);

  it("reports a missing file, bad JSON and schema errors", () => {
    expect(checkCurriculum(undefined, valid)).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/not written/)],
    });
    expect(checkCurriculum("{", valid)).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/not valid JSON/)],
    });
    expect(checkCurriculum(json({ modules: [] }), valid)).toMatchObject({ ok: false });
  });

  it("drops unknown citations and prerequisites with warnings, and normalises", () => {
    const res = checkCurriculum(
      json({
        modules: [
          {
            title: "M",
            goal: "Do it",
            concepts: [concept("A", ["chk_a", "chk_zzz"]), concept("B", ["chk_b"], ["a", "Ghost"])],
          },
        ],
      }),
      valid,
    );
    if (!res.ok) throw new Error(res.problems.join());
    const [a, b] = res.curriculum.modules[0]!.concepts;
    expect(a!.citations).toEqual(["chk_a"]);
    expect(b!.prerequisites).toEqual(["a"]);
    expect(a!.difficulty).toBe(3);
    expect(res.warnings.join("\n")).toMatch(/chk_zzz[\s\S]*Ghost/);
  });

  it("rejects a concept with no valid citation and a module without a goal", () => {
    const res = checkCurriculum(
      json({ modules: [{ title: "M", concepts: [concept("A", ["chk_nope"])] }] }),
      valid,
    );
    expect(res).toMatchObject({ ok: false });
    if (!res.ok)
      expect(res.problems.join("\n")).toMatch(
        /"M" has an empty goal[\s\S]*"A" has no valid chunk citation/,
      );
  });
});

describe("saveCurriculum", () => {
  let h: DbHandle;
  let schoolId: string;
  let chunkIds: string[];
  beforeEach(async () => {
    h = openDb(":memory:");
    runMigrations(h);
    schoolId = ensureSchool(h, "Blockchain").id;
    await ingestSource(
      { handle: h, embedder: new BowEmbedder(), dataDir: mkdtempSync(join(tmpdir(), "cur-")) },
      { schoolId, title: "t", kind: "md", data: "# A\nalpha text.\n\n# B\nbeta text." },
    );
    chunkIds = (
      h.sqlite.prepare("SELECT id FROM chunks ORDER BY ord").all() as { id: string }[]
    ).map((r) => r.id);
  });
  afterEach(() => h.close());

  const curriculum = (): Curriculum => ({
    modules: [
      {
        title: "One",
        goal: "g1",
        concepts: [
          concept("Hashing", [chunkIds[0]!]),
          concept("Merkle", [chunkIds[1]!], ["hashing"]),
        ],
      },
      {
        title: "Two",
        goal: "g2",
        concepts: [concept("Paths", [chunkIds[0]!, chunkIds[1]!], ["Merkle"])],
      },
    ],
  });

  it("stores modules, concepts, citations and prerequisite ids", () => {
    expect(saveCurriculum(h, schoolId, curriculum())).toEqual({ modules: 2, concepts: 3 });
    const all = h.db.select().from(concepts).all();
    const byTitle = Object.fromEntries(all.map((c) => [c.title, c]));
    expect(JSON.parse(byTitle.Merkle!.prerequisitesJson)).toEqual([byTitle.Hashing!.id]);
    expect(JSON.parse(byTitle.Paths!.prerequisitesJson)).toEqual([byTitle.Merkle!.id]);
    expect(h.db.select().from(conceptCitations).all()).toHaveLength(4);
    expect(
      h.db
        .select()
        .from(modules)
        .all()
        .map((m) => [m.ord, m.title]),
    ).toEqual([
      [0, "One"],
      [1, "Two"],
    ]);
  });

  it("replaces an untaught curriculum", () => {
    saveCurriculum(h, schoolId, curriculum());
    saveCurriculum(h, schoolId, {
      modules: [{ title: "Only", goal: "g", concepts: [concept("X", [chunkIds[0]!])] }],
    });
    expect(
      h.db
        .select()
        .from(concepts)
        .all()
        .map((c) => c.title),
    ).toEqual(["X"]);
    expect(h.db.select().from(conceptCitations).all()).toHaveLength(1);
  });

  it("refuses to replace a curriculum cadets have already learned", () => {
    saveCurriculum(h, schoolId, curriculum());
    const classroomId = newId("classroom");
    const cadetId = newId("cadet");
    const now = new Date().toISOString();
    h.db
      .insert(classrooms)
      .values({ id: classroomId, schoolId, name: "A", status: "active", seed: 1, createdAt: now })
      .run();
    h.db
      .insert(cadets)
      .values({
        id: cadetId,
        classroomId,
        seat: 0,
        name: "Ines",
        homeworld: "Titan",
        archetype: "skeptic",
        traitsJson: "{}",
        learningStyle: "formal",
        quirk: "q",
        voiceNotes: "v",
        enrolledAt: now,
      })
      .run();
    const conceptId = h.db.select().from(concepts).all()[0]!.id;
    h.db.insert(ledgerEntries).values({ cadetId, conceptId, comprehension: 0.4 }).run();
    expect(() => saveCurriculum(h, schoolId, curriculum())).toThrow(/already been taught/);
    expect(h.db.select().from(concepts).all()).toHaveLength(3);
  });
});
