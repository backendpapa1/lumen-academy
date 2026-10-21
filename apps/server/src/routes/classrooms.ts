import type { FastifyInstance } from "fastify";
import type { DbHandle } from "../db/client.js";

// REST for picking a School and Classroom (docs/05 §6, read side for M2).

export function registerClassroomRoutes(app: FastifyInstance, handle: DbHandle) {
  const { sqlite } = handle;

  app.get("/api/schools", async () => {
    const schools = sqlite
      .prepare(
        "SELECT id, name, description, building_tier AS buildingTier FROM schools WHERE archived = 0 ORDER BY campus_slot",
      )
      .all() as Array<{ id: string; name: string }>;
    const rooms = sqlite
      .prepare(
        `SELECT c.id, c.school_id AS schoolId, c.name, c.status, c.current_concept_id AS currentConceptId,
           (SELECT count(*) FROM cadets d WHERE d.classroom_id = c.id AND d.status IN ('enrolled','transferred_in')) AS cadets,
           (SELECT max(p.started_at) FROM periods p WHERE p.classroom_id = c.id) AS lastPeriodAt,
           (SELECT p.elapsed_ms FROM periods p WHERE p.classroom_id = c.id AND p.ended_at IS NULL
              ORDER BY p.started_at DESC LIMIT 1) AS openPeriodElapsedMs
         FROM classrooms c ORDER BY c.created_at`,
      )
      .all() as Array<{ schoolId: string }>;
    return schools.map((s) => ({ ...s, classrooms: rooms.filter((r) => r.schoolId === s.id) }));
  });

  app.get<{ Params: { id: string } }>("/api/classrooms/:id", async (req, reply) => {
    const room = sqlite
      .prepare(
        "SELECT id, school_id AS schoolId, name, status, difficulty, current_concept_id AS currentConceptId FROM classrooms WHERE id = ?",
      )
      .get(req.params.id);
    if (!room) return reply.code(404).send({ error: "no such classroom" });
    const cadets = sqlite
      .prepare(
        "SELECT id, name, archetype, seat, homeworld, quirk FROM cadets WHERE classroom_id = ? AND status IN ('enrolled','transferred_in') ORDER BY seat",
      )
      .all(req.params.id);
    return { ...room, cadets };
  });
}
