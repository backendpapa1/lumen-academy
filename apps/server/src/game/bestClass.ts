import type { GameConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { resumeTarget } from "./campus.js";
import { fadingTarget } from "./fading.js";
import { recall } from "./memory.js";

// "Today's best class" (V3-03, ADHD rule 1): one button, no choosing. A fading
// concept first (it's cheapest to save now), else the next one nobody has met,
// else the class's weakest. It says why in one line, so it never feels random.

export interface BestClass {
  classroomId: string;
  classroomName: string;
  schoolName: string;
  conceptId: string;
  conceptTitle: string;
  why: "fading" | "next" | "weak";
  reason: string;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function bestClass(handle: DbHandle, game: GameConfig, now = new Date()): BestClass | null {
  const fading = fadingTarget(handle, game, now);
  if (fading)
    return {
      classroomId: fading.classroomId,
      classroomName: fading.classroomName,
      schoolName: fading.schoolName,
      conceptId: fading.conceptId,
      conceptTitle: fading.conceptTitle,
      why: "fading",
      reason: `Your class is forgetting it: ${pct(fading.was)} → ${pct(fading.now)}. A short review saves it.`,
    };

  const { sqlite } = handle;
  const last = resumeTarget(handle);
  const room = (
    last
      ? sqlite
          .prepare(
            "SELECT c.id, c.name, c.school_id AS schoolId, s.name AS schoolName FROM classrooms c JOIN schools s ON s.id = c.school_id WHERE c.id = ?",
          )
          .get(last.classroomId)
      : sqlite
          .prepare(
            `SELECT c.id, c.name, c.school_id AS schoolId, s.name AS schoolName FROM classrooms c
             JOIN schools s ON s.id = c.school_id WHERE c.status = 'active' AND s.archived = 0
             ORDER BY c.created_at DESC LIMIT 1`,
          )
          .get()
  ) as { id: string; name: string; schoolId: string; schoolName: string } | undefined;
  if (!room) return null;

  const concepts = sqlite
    .prepare(
      `SELECT k.id, k.title FROM concepts k JOIN modules m ON m.id = k.module_id
       WHERE m.school_id = ? ORDER BY m.ord, k.ord`,
    )
    .all(room.schoolId) as Array<{ id: string; title: string }>;
  if (!concepts.length) return null;
  const rows = sqlite
    .prepare(
      `SELECT l.concept_id AS conceptId, l.comprehension AS c, l.exposures AS n,
         l.last_taught_at AS at, l.stability_days AS st
       FROM ledger_entries l JOIN cadets d ON d.id = l.cadet_id
       WHERE d.classroom_id = ? AND d.status IN ('enrolled','transferred_in')`,
    )
    .all(room.id) as Array<{
    conceptId: string;
    c: number;
    n: number;
    at: string | null;
    st: number | null;
  }>;
  const base = {
    classroomId: room.id,
    classroomName: room.name,
    schoolName: room.schoolName,
  };
  const met = new Set(rows.filter((r) => r.n > 0).map((r) => r.conceptId));
  const next = concepts.find((k) => !met.has(k.id));
  if (next)
    return {
      ...base,
      conceptId: next.id,
      conceptTitle: next.title,
      why: "next",
      reason: met.size
        ? `Next in the curriculum: nobody in ${room.name} has met it yet.`
        : `The first concept in the curriculum. A good place to start.`,
    };

  let weakest: { id: string; title: string; now: number } | null = null;
  for (const k of concepts) {
    const own = rows.filter((r) => r.conceptId === k.id);
    if (!own.length) continue;
    const avg = own.reduce((a, r) => a + recall(r.c, r.at, r.st, now, game.memory), 0) / own.length;
    if (!weakest || avg < weakest.now) weakest = { id: k.id, title: k.title, now: avg };
  }
  if (!weakest) return null;
  return {
    ...base,
    conceptId: weakest.id,
    conceptTitle: weakest.title,
    why: "weak",
    reason: `Your class's weakest concept, at ${pct(weakest.now)}.`,
  };
}
