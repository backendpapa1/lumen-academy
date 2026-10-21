import type { GameConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { recall } from "./memory.js";

// Prerequisite detective (V5-06): a failed exam answer or a wrong exit ticket
// on one concept often starts in an earlier one. Walk the prerequisite graph
// back from the miss to the weakest concept the class doesn't hold, and pin
// "start here" on it. Pure graph plus ledger: no LLM.

export interface Miss {
  cadetId: string;
  cadetName: string;
  conceptId: string;
  /** "exam" or "exit ticket" */
  where: string;
}

export interface StartHere {
  conceptId: string;
  title: string;
  /** Why this concept: never taught, or the class only holds it at n%. */
  reason: string;
  /** The misses it explains: "Kai's exam miss on Merkle paths". */
  because: Array<{ cadet: string; concept: string; where: string }>;
  /** The chain from the start here concept up to the missed one, titles. */
  path: string[];
}

interface Node {
  id: string;
  title: string;
  prereqs: string[];
}

/** The class's recalled understanding of each concept (null: never taught). */
function classLevels(
  handle: DbHandle,
  game: GameConfig,
  classroomId: string,
  now: Date,
): Map<string, number | null> {
  const rows = handle.sqlite
    .prepare(
      `SELECT l.concept_id AS id, l.comprehension AS c, l.exposures AS n, l.last_taught_at AS at, l.stability_days AS st
       FROM ledger_entries l JOIN cadets d ON d.id = l.cadet_id
       WHERE d.classroom_id = ? AND d.status IN ('enrolled','transferred_in')`,
    )
    .all(classroomId) as Array<{
    id: string;
    c: number;
    n: number;
    at: string | null;
    st: number | null;
  }>;
  const by = new Map<string, number[]>();
  for (const r of rows)
    if (r.n > 0) by.set(r.id, [...(by.get(r.id) ?? []), recall(r.c, r.at, r.st, now, game.memory)]);
  return new Map([...by].map(([id, xs]) => [id, xs.reduce((a, b) => a + b, 0) / xs.length]));
}

/**
 * For one miss: the weakest prerequisite ancestor (breadth-first, nearest
 * first on ties) the class holds below "understood", or null if every
 * prerequisite is solid (then the miss is about the concept itself).
 */
export function traceMiss(
  graph: Map<string, Node>,
  levels: Map<string, number | null>,
  understoodAt: number,
  conceptId: string,
): { id: string; path: string[]; level: number | null } | null {
  const seen = new Set([conceptId]);
  let frontier = [{ id: conceptId, path: [conceptId] }];
  let best: { id: string; path: string[]; level: number | null } | null = null;
  for (let depth = 0; depth < 5 && frontier.length; depth++) {
    const next: typeof frontier = [];
    for (const f of frontier)
      for (const p of graph.get(f.id)?.prereqs ?? []) {
        if (seen.has(p) || !graph.has(p)) continue;
        seen.add(p);
        const path = [p, ...f.path];
        next.push({ id: p, path });
        const level = levels.get(p) ?? null;
        if (level !== null && level >= understoodAt) continue;
        // Never taught beats taught-but-weak; lower beats higher; nearer wins ties.
        const rank = (l: number | null) => (l === null ? -1 : l);
        if (!best || rank(level) < rank(best.level)) best = { id: p, path, level };
      }
    frontier = next;
  }
  return best;
}

export function startHere(
  handle: DbHandle,
  game: GameConfig,
  input: { classroomId: string; misses: Miss[]; now?: Date },
): StartHere[] {
  const { sqlite } = handle;
  const nodes = sqlite
    .prepare(
      `SELECT k.id, k.title, k.prerequisites_json p FROM concepts k JOIN modules m ON m.id = k.module_id
       JOIN classrooms c ON c.school_id = m.school_id WHERE c.id = ?`,
    )
    .all(input.classroomId) as Array<{ id: string; title: string; p: string }>;
  const graph = new Map<string, Node>(
    nodes.map((n) => [n.id, { id: n.id, title: n.title, prereqs: JSON.parse(n.p) as string[] }]),
  );
  const levels = classLevels(handle, game, input.classroomId, input.now ?? new Date());
  const out = new Map<string, StartHere>();
  for (const m of input.misses) {
    const hit = traceMiss(graph, levels, game.comprehension.understoodAt, m.conceptId);
    if (!hit) continue;
    const entry = out.get(hit.id) ?? {
      conceptId: hit.id,
      title: graph.get(hit.id)!.title,
      reason:
        hit.level === null
          ? "You haven't taught it yet."
          : `Your class only holds it at ${Math.round(hit.level * 100)}%.`,
      because: [],
      path: hit.path.map((id) => graph.get(id)!.title),
    };
    entry.because.push({
      cadet: m.cadetName.split(" ")[0]!,
      concept: graph.get(m.conceptId)?.title ?? "",
      where: m.where,
    });
    out.set(hit.id, entry);
  }
  return [...out.values()].sort((a, b) => b.because.length - a.because.length);
}

/** Recent misses in a classroom: failed exam answers and wrong exit tickets (last N days). */
export function recentMisses(handle: DbHandle, classroomId: string, days = 21): Miss[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const exam = handle.sqlite
    .prepare(
      `SELECT r.cadet_id AS cadetId, d.name AS cadetName, q.concept_id AS conceptId FROM exam_results r
       JOIN exam_questions q ON q.id = r.question_id JOIN exams e ON e.id = r.exam_id JOIN cadets d ON d.id = r.cadet_id
       WHERE e.classroom_id = ? AND r.score < 0.5 AND q.concept_id IS NOT NULL AND e.created_at >= ?`,
    )
    .all(classroomId, since) as Array<Omit<Miss, "where">>;
  const tickets = handle.sqlite
    .prepare(
      `SELECT t.cadet_id AS cadetId, d.name AS cadetName, t.concept_id AS conceptId FROM exit_tickets t
       JOIN periods p ON p.id = t.period_id JOIN cadets d ON d.id = t.cadet_id
       WHERE p.classroom_id = ? AND t.is_true = 0 AND t.concept_id IS NOT NULL AND t.created_at >= ?`,
    )
    .all(classroomId, since) as Array<Omit<Miss, "where">>;
  return [
    ...exam.map((m) => ({ ...m, where: "exam" })),
    ...tickets.map((m) => ({ ...m, where: "exit ticket" })),
  ];
}
