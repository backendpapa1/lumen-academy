import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, runMigrations, type DbHandle } from "../db/client.js";
import { saveCurriculum } from "../db/curriculum.js";
import { newId } from "../db/ids.js";
import { cadets, classrooms, concepts } from "../db/schema.js";
import { ensureSchool, ingestSource } from "../ingest/pipeline.js";
import { BowEmbedder } from "./bowEmbedder.js";

/** An in-memory School with one source, a 2-concept curriculum and a classroom of cadets. */
export async function smallWorld(
  cadetTraits: Array<{ attention: number; skepticism: number; learningStyle?: string }>,
) {
  const handle: DbHandle = openDb(":memory:");
  runMigrations(handle);
  const schoolId = ensureSchool(handle, "Blockchain").id;
  await ingestSource(
    { handle, embedder: new BowEmbedder(), dataDir: mkdtempSync(join(tmpdir(), "world-")) },
    {
      schoolId,
      title: "t",
      kind: "md",
      data: "# Merkle\nPairs are hashed up to a root.\n\n# Header\nThe root lives in the header.",
    },
  );
  const chunk = (
    handle.sqlite.prepare("SELECT id FROM chunks ORDER BY ord").get() as { id: string }
  ).id;
  const fact = (t: string) => ({
    title: t,
    summary: t,
    keyFacts: [`${t} a`, `${t} b`, `${t} c`, `${t} d`],
    misconceptions: [],
    prerequisites: [],
    citations: [chunk],
    difficulty: 2,
  });
  saveCurriculum(handle, schoolId, {
    modules: [{ title: "M", goal: "g", concepts: [fact("Merkle Trees"), fact("Block Header")] }],
  });
  const conceptIds = handle.db
    .select()
    .from(concepts)
    .orderBy(concepts.ord)
    .all()
    .map((c) => c.id);
  const classroomId = newId("classroom");
  const now = new Date().toISOString();
  handle.db
    .insert(classrooms)
    .values({
      id: classroomId,
      schoolId,
      name: "Class A",
      status: "active",
      seed: 1,
      createdAt: now,
    })
    .run();
  const cadetRows = cadetTraits.map((t, i) => ({
    id: newId("cadet"),
    attention: t.attention,
    skepticism: t.skepticism,
    learningStyle: (t.learningStyle ?? "formal") as "formal",
    seat: i,
  }));
  for (const c of cadetRows) {
    handle.db
      .insert(cadets)
      .values({
        id: c.id,
        classroomId,
        seat: c.seat,
        name: `Cadet ${c.seat}`,
        homeworld: "Titan",
        archetype: "skeptic",
        traitsJson: JSON.stringify({ attention: c.attention, skepticism: c.skepticism }),
        learningStyle: c.learningStyle,
        quirk: "q",
        voiceNotes: "v",
        enrolledAt: now,
      })
      .run();
  }
  return { handle, schoolId, classroomId, conceptIds, cadets: cadetRows };
}
