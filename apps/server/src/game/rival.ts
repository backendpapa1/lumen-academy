import type { DbHandle } from "../db/client.js";
import { newId } from "../db/ids.js";
import { rng, seedFrom } from "./rng.js";

// The rival class (V7-05, VD14): "another teacher" on the same School, simulated.
// Their exam scores follow a seeded, believable curve (they get a little better
// module by module, with some noise), shifted by the class's difficulty, so
// it's a fair race. No second human and no extra LLM calls.

/** Made-up teachers, never real people. */
const RIVALS = [
  "Ms Okafor-Lind",
  "Mr Ashworth",
  "Ms Brennan-Tao",
  "Mr Delacroix-Mensah",
  "Ms Ferraro",
];
const SHIFT: Record<string, number> = { gentle: 0.06, standard: 0, ruthless: -0.06 };

export interface RivalResult {
  teacher: string;
  className: string;
  score: number;
  beaten: boolean;
  trophy: boolean;
}

export function rivalTeacher(schoolId: string): string {
  return RIVALS[seedFrom(schoolId, "rival") % RIVALS.length]!;
}

/** The rival's exam average on a module, 0..1: stable for the same School and module. */
export function rivalScore(schoolId: string, moduleOrd: number, difficulty: string): number {
  const r = rng(seedFrom(schoolId, moduleOrd, "rival-exam"));
  const base = 0.6 + (r() - 0.5) * 0.18 + Math.min(0.12, moduleOrd * 0.03);
  return Math.max(0.35, Math.min(0.95, base + (SHIFT[difficulty] ?? 0)));
}

/** How my exam did against the rival; beating them earns one trophy per exam. */
export function rivalFor(handle: DbHandle, examId: string): RivalResult | null {
  const { sqlite } = handle;
  const e = sqlite
    .prepare(
      `SELECT e.id, e.class_average avg, e.status, m.ord, m.title module, c.school_id s, c.id cid, c.difficulty d
       FROM exams e JOIN modules m ON m.id = e.module_id JOIN classrooms c ON c.id = e.classroom_id WHERE e.id = ?`,
    )
    .get(examId) as
    | {
        id: string;
        avg: number | null;
        status: string;
        ord: number;
        module: string;
        s: string;
        cid: string;
        d: string;
      }
    | undefined;
  if (!e || e.status !== "done" || e.avg === null) return null;
  const teacher = rivalTeacher(e.s);
  const score = rivalScore(e.s, e.ord, e.d);
  const beaten = e.avg > score;
  let trophy = false;
  if (beaten) {
    const had = sqlite.prepare("SELECT 1 FROM trophies WHERE exam_id = ?").get(e.id);
    if (!had) {
      sqlite
        .prepare(
          "INSERT INTO trophies (id, school_id, classroom_id, kind, exam_id, note, created_at) VALUES (?, ?, ?, 'rival', ?, ?, ?)",
        )
        .run(
          newId("trophy"),
          e.s,
          e.cid,
          e.id,
          `Beat ${teacher}'s class on ${e.module}`,
          new Date().toISOString(),
        );
    }
    trophy = true;
  }
  return { teacher, className: `${teacher.split(" ").at(-1)}'s class`, score, beaten, trophy };
}

export function trophyCount(handle: DbHandle, schoolId: string): number {
  return (
    handle.sqlite.prepare("SELECT count(*) n FROM trophies WHERE school_id = ?").get(schoolId) as {
      n: number;
    }
  ).n;
}
