import type { FastifyInstance } from "fastify";
import type { CrowdReaction, GameConfig, TeachingAnalysis } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { recentMisses, startHere } from "../game/detective.js";

// After-class insight (V5-06, V5-07), all from data already stored: where a
// miss really starts (the prerequisite detective) and which of my
// explanations confused or cleared the class (the confusion map).

const CONFUSED = new Set(["confused", "skeptical"]);
const CLEAR = new Set(["attentive", "excited", "notetaking"]);

export interface ConfusionTurn {
  ord: number;
  text: string;
  confused: string[];
  cleared: string[];
  /** Mix-ups the Director saw me fix on this turn. */
  fixed: number;
}

export function confusionMap(handle: DbHandle, periodId: string): ConfusionTurn[] {
  const { sqlite } = handle;
  const names = new Map(
    (
      sqlite
        .prepare(
          `SELECT d.id, d.name FROM cadets d JOIN periods p ON p.classroom_id = d.classroom_id WHERE p.id = ?`,
        )
        .all(periodId) as Array<{ id: string; name: string }>
    ).map((r) => [r.id, r.name.split(" ")[0]!]),
  );
  const rows = sqlite
    .prepare(
      `SELECT t.ord, m.text, t.reactions_json r, t.analysis_json a FROM turns t
       JOIN messages m ON m.id = t.teacher_message_id WHERE t.period_id = ? ORDER BY t.ord`,
    )
    .all(periodId) as Array<{ ord: number; text: string; r: string; a: string }>;
  let before = new Map<string, string>();
  return rows.map((row) => {
    const reaction = JSON.parse(row.r) as Partial<CrowdReaction>;
    const analysis = JSON.parse(row.a) as Partial<TeachingAnalysis>;
    const now = new Map((reaction.reactions ?? []).map((x) => [x.cadetId, x.state as string]));
    const confused = [...now]
      .filter(([, s]) => CONFUSED.has(s))
      .map(([id]) => names.get(id) ?? "?");
    const cleared = [...now]
      .filter(([id, s]) => CLEAR.has(s) && CONFUSED.has(before.get(id) ?? ""))
      .map(([id]) => names.get(id) ?? "?");
    before = now;
    return {
      ord: row.ord,
      text: row.text,
      confused,
      cleared,
      fixed: (analysis.ledgerDeltas ?? []).filter((d) => d.resolvedMisconception).length,
    };
  });
}

export function registerInsightRoutes(
  app: FastifyInstance,
  deps: { handle: DbHandle; game: GameConfig },
) {
  const { sqlite } = deps.handle;

  /** V5-06: "start here" pins for a School's curriculum map, from recent misses in its classes. */
  app.get<{ Params: { id: string } }>("/api/schools/:id/start-here", async (req, reply) => {
    const rooms = sqlite
      .prepare("SELECT id FROM classrooms WHERE school_id = ? AND status IN ('active','graduated')")
      .all(req.params.id) as Array<{ id: string }>;
    if (!rooms.length && !sqlite.prepare("SELECT 1 FROM schools WHERE id = ?").get(req.params.id))
      return reply.code(404).send({ error: "no such School" });
    const merged = new Map<string, ReturnType<typeof startHere>[number]>();
    for (const r of rooms)
      for (const s of startHere(deps.handle, deps.game, {
        classroomId: r.id,
        misses: recentMisses(deps.handle, r.id),
      })) {
        const had = merged.get(s.conceptId);
        if (had) had.because.push(...s.because);
        else merged.set(s.conceptId, s);
      }
    return [...merged.values()].sort((a, b) => b.because.length - a.because.length);
  });

  /** V5-07: my explanations in one period, with who each confused or cleared. */
  app.get<{ Params: { id: string } }>("/api/periods/:id/confusion", async (req, reply) => {
    if (!sqlite.prepare("SELECT 1 FROM periods WHERE id = ?").get(req.params.id))
      return reply.code(404).send({ error: "no such period" });
    return confusionMap(deps.handle, req.params.id);
  });
}
