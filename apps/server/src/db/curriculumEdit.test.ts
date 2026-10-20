import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EditableCurriculum } from "@lumen/shared";
import { ensureSchool, ingestSource } from "../ingest/pipeline.js";
import { BowEmbedder } from "../test-fixtures/bowEmbedder.js";
import { openDb, runMigrations, type DbHandle } from "./client.js";
import { saveCurriculum } from "./curriculum.js";
import {
  CurriculumEditError,
  exportCurriculumYaml,
  importCurriculumYaml,
  loadEditableCurriculum,
} from "./curriculumEdit.js";
import { newId } from "./ids.js";
import { cadets, classrooms, ledgerEntries } from "./schema.js";

let h: DbHandle;
let schoolId: string;
let chunk: string[];
const concept = (title: string, citations: string[], prerequisites: string[] = []) => ({
  title,
  summary: `${title}.`,
  keyFacts: [`${title} fact 1`, `${title} fact 2`],
  misconceptions: [],
  prerequisites,
  citations,
  difficulty: 2,
});

beforeEach(async () => {
  h = openDb(":memory:");
  runMigrations(h);
  schoolId = ensureSchool(h, "Blockchain").id;
  await ingestSource(
    { handle: h, embedder: new BowEmbedder(), dataDir: mkdtempSync(join(tmpdir(), "ed-")) },
    { schoolId, title: "t", kind: "md", data: "# A\nalpha.\n\n# B\nbeta.\n\n# C\ngamma." },
  );
  chunk = (h.sqlite.prepare("SELECT id FROM chunks ORDER BY ord").all() as { id: string }[]).map(
    (r) => r.id,
  );
  saveCurriculum(h, schoolId, {
    modules: [
      {
        title: "Basics",
        goal: "Know basics",
        concepts: [concept("Hashing", [chunk[0]!]), concept("Blocks", [chunk[1]!], ["Hashing"])],
      },
      {
        title: "Trees",
        goal: "Know trees",
        concepts: [
          concept("Merkle", [chunk[2]!], ["Hashing"]),
          concept("Merkle Trees", [chunk[2]!]),
        ],
      },
    ],
  });
});
afterEach(() => h.close());

const edit = (fn: (c: EditableCurriculum) => void) => {
  const c = parse(exportCurriculumYaml(h, schoolId)) as EditableCurriculum;
  fn(c);
  return importCurriculumYaml(h, schoolId, stringify(c));
};
const titles = () =>
  loadEditableCurriculum(h, schoolId).modules.map((m) => [m.title, m.concepts.map((c) => c.title)]);
const idOf = (title: string) =>
  loadEditableCurriculum(h, schoolId)
    .modules.flatMap((m) => m.concepts)
    .find((c) => c.title === title)!.id!;

function teach(title: string) {
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
  h.db
    .insert(ledgerEntries)
    .values({ cadetId, conceptId: idOf(title), comprehension: 0.5 })
    .run();
}

describe("curriculum YAML", () => {
  it("round-trips unchanged, with ids and a how-to header", () => {
    const yaml = exportCurriculumYaml(h, schoolId);
    expect(yaml).toMatch(/^# Lumen Academy curriculum/);
    expect(yaml).toContain("id: cpt_");
    const before = loadEditableCurriculum(h, schoolId);
    expect(importCurriculumYaml(h, schoolId, yaml)).toMatchObject({
      updated: 4,
      added: 0,
      deleted: 0,
    });
    expect(loadEditableCurriculum(h, schoolId)).toEqual(before);
  });

  it("renames in place: the id, and the ledger on it, survive", () => {
    teach("Hashing");
    const id = idOf("Hashing");
    edit((c) => {
      c.modules[0]!.concepts[0]!.title = "Cryptographic Hashing";
      for (const k of c.modules.flatMap((m) => m.concepts))
        k.prerequisites = k.prerequisites.map((p) =>
          p === "Hashing" ? "Cryptographic Hashing" : p,
        );
    });
    expect(idOf("Cryptographic Hashing")).toBe(id);
    expect(h.db.select().from(ledgerEntries).all()[0]!.conceptId).toBe(id);
  });

  it("reorders modules and concepts", () => {
    edit((c) => {
      c.modules.reverse();
      c.modules[1]!.concepts.reverse();
    });
    expect(titles()).toEqual([
      ["Trees", ["Merkle", "Merkle Trees"]],
      ["Basics", ["Blocks", "Hashing"]],
    ]);
  });

  it("merges two concepts and deletes an emptied module", () => {
    const keep = idOf("Merkle");
    edit((c) => {
      const [a, b] = c.modules[1]!.concepts;
      a!.keyFacts.push(...b!.keyFacts);
      c.modules[1]!.concepts = [a!];
      c.modules[0]!.concepts.push(c.modules[1]!.concepts.pop()!);
      c.modules.pop();
    });
    expect(titles()).toEqual([["Basics", ["Hashing", "Blocks", "Merkle"]]]);
    expect(idOf("Merkle")).toBe(keep);
    expect(loadEditableCurriculum(h, schoolId).modules[0]!.concepts[2]!.keyFacts).toHaveLength(4);
  });

  it("adds a new concept with prerequisites by title", () => {
    const s = edit((c) =>
      c.modules[1]!.concepts.push(concept("Merkle Paths", [chunk[2]!], ["Merkle"])),
    );
    expect(s).toMatchObject({ added: 1 });
    const paths = loadEditableCurriculum(h, schoolId).modules[1]!.concepts.at(-1)!;
    expect(paths.prerequisites).toEqual(["Merkle"]);
  });

  it("refuses to delete a concept cadets have learned", () => {
    teach("Blocks");
    expect(() => edit((c) => c.modules[0]!.concepts.pop())).toThrow(/can't delete "Blocks"/);
    expect(titles()[0]![1]).toContain("Blocks");
  });

  it("validates everything before changing anything", () => {
    const err = (() => {
      try {
        edit((c) => {
          c.modules[0]!.concepts[1]!.prerequisites = ["Nope"];
          c.modules[0]!.concepts[0]!.citations = ["chk_fake"];
          c.modules[1]!.concepts[1]!.title = "Merkle";
          c.modules[0]!.goal = "";
          c.modules[0]!.concepts[0]!.difficulty = 9;
        });
      } catch (e) {
        return e as CurriculumEditError;
      }
    })();
    expect(err).toBeInstanceOf(CurriculumEditError);
    const all = err!.problems.join("\n");
    for (const p of [
      /prerequisite "Nope"/,
      /unknown chunk ids chk_fake/,
      /duplicate concept title "merkle"/,
      /"Basics" needs a goal/,
      /difficulty must be 1–5/,
    ])
      expect(all).toMatch(p);
    expect(titles()).toEqual([
      ["Basics", ["Hashing", "Blocks"]],
      ["Trees", ["Merkle", "Merkle Trees"]],
    ]);
  });

  it("rejects ids from another school and bad YAML", () => {
    expect(() => edit((c) => (c.modules[0]!.concepts[0]!.id = "cpt_somewhereelse"))).toThrow(
      /doesn't belong/,
    );
    expect(() => importCurriculumYaml(h, schoolId, "modules: [")).toThrow(/not valid YAML/);
  });
});
