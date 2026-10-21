import type { GameConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { recall } from "./memory.js";

// "Your class is forgetting…" (V2-03): across active classes, the concept whose
// students have let the most slip, weighted by how well it was known (a
// half-learned concept fading matters less than a mastered one). One at a
// time, never a nag list.

export interface FadingTarget {
  classroomId: string;
  classroomName: string;
  schoolName: string;
  conceptId: string;
  conceptTitle: string;
  /** Days since it was last taught in this class. */
  days: number;
  /** Class understanding then and now, 0..1. */
  was: number;
  now: number;
}

export function fadingTarget(
  handle: DbHandle,
  game: GameConfig,
  now = new Date(),
): FadingTarget | null {
  const rows = handle.sqlite
    .prepare(
      `SELECT r.id AS classroomId, r.name AS classroomName, s.name AS schoolName, k.id AS conceptId,
         k.title AS conceptTitle, l.comprehension AS c, l.last_taught_at AS at, l.stability_days AS st
       FROM ledger_entries l JOIN cadets d ON d.id = l.cadet_id JOIN classrooms r ON r.id = d.classroom_id
       JOIN schools s ON s.id = r.school_id JOIN concepts k ON k.id = l.concept_id
       WHERE r.status = 'active' AND s.archived = 0 AND d.status IN ('enrolled','transferred_in')
         AND l.exposures > 0 AND l.comprehension > 0 AND l.last_taught_at IS NOT NULL`,
    )
    .all() as Array<{
    classroomId: string;
    classroomName: string;
    schoolName: string;
    conceptId: string;
    conceptTitle: string;
    c: number;
    at: string;
    st: number | null;
  }>;
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.classroomId}|${r.conceptId}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  let best: (FadingTarget & { score: number }) | null = null;
  for (const g of groups.values()) {
    const was = g.reduce((a, r) => a + r.c, 0) / g.length;
    const nowAvg = g.reduce((a, r) => a + recall(r.c, r.at, r.st, now, game.memory), 0) / g.length;
    if (was <= 0 || nowAvg / was >= game.memory.fadingAt) continue;
    const score = (was - nowAvg) * was;
    if (best && score <= best.score) continue;
    const last = g.reduce((a, r) => (r.at > a ? r.at : a), g[0]!.at);
    best = {
      classroomId: g[0]!.classroomId,
      classroomName: g[0]!.classroomName,
      schoolName: g[0]!.schoolName,
      conceptId: g[0]!.conceptId,
      conceptTitle: g[0]!.conceptTitle,
      days: Math.floor((now.getTime() - Date.parse(last)) / 86_400_000),
      was,
      now: nowAvg,
      score,
    };
  }
  if (!best) return null;
  return {
    classroomId: best.classroomId,
    classroomName: best.classroomName,
    schoolName: best.schoolName,
    conceptId: best.conceptId,
    conceptTitle: best.conceptTitle,
    days: best.days,
    was: best.was,
    now: best.now,
  };
}
