import type { FastifyInstance } from "fastify";
import type { DbHandle } from "../db/client.js";

// REST for picking a School and Classroom (docs/05 §6, read side for M2).

export function registerClassroomRoutes(app: FastifyInstance, handle: DbHandle) {
  const { sqlite } = handle;

  app.get("/api/schools", async () => {
    const schools = sqlite
      .prepare(
        `SELECT s.id, s.name, s.description, s.building_tier AS buildingTier, s.accent_color AS accent,
           CASE WHEN (SELECT status FROM assets a WHERE a.id = s.emblem_asset_id) = 'ready'
             THEN '/api/assets/' || s.emblem_asset_id END AS emblemUrl,
           (SELECT count(*) FROM sources x WHERE x.school_id = s.id AND x.status = 'ready') AS sources,
           (SELECT count(*) FROM concepts c JOIN modules m ON m.id = c.module_id WHERE m.school_id = s.id) AS concepts
         FROM schools s WHERE s.archived = 0 ORDER BY s.campus_slot`,
      )
      .all() as Array<{ id: string; name: string }>;
    const rooms = sqlite
      .prepare(
        `SELECT c.id, c.school_id AS schoolId, c.name, c.status, c.current_concept_id AS currentConceptId,
           (SELECT count(*) FROM cadets d WHERE d.classroom_id = c.id AND d.status IN ('enrolled','transferred_in')) AS cadets,
           (SELECT max(p.started_at) FROM periods p WHERE p.classroom_id = c.id) AS lastPeriodAt,
           (SELECT p.elapsed_ms FROM periods p WHERE p.classroom_id = c.id AND p.ended_at IS NULL
              ORDER BY p.started_at DESC LIMIT 1) AS openPeriodElapsedMs
         FROM classrooms c WHERE c.status != 'archived' ORDER BY c.created_at`,
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
        `SELECT d.id, d.name, d.archetype, d.seat, d.homeworld, d.quirk,
           CASE WHEN (SELECT status FROM assets a WHERE a.id = d.portrait_asset_id) = 'ready'
             THEN '/api/assets/' || d.portrait_asset_id END AS portraitUrl
         FROM cadets d WHERE d.classroom_id = ? AND d.status IN ('enrolled','transferred_in') ORDER BY d.seat`,
      )
      .all(req.params.id);
    return { ...room, cadets };
  });
}
