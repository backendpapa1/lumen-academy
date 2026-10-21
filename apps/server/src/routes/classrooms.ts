import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { DbHandle } from "../db/client.js";
import { hairOf, registerOf } from "../game/looks.js";
import type { GameConfig } from "@lumen/shared";
import { placeUpgrade, removeUpgrade, upgradeState } from "../game/upgrades.js";
import { seriesBefore } from "../agents/curriculum/build.js";

// REST for picking a School and Classroom (docs/05 §6, read side for M2).

export function registerClassroomRoutes(app: FastifyInstance, handle: DbHandle, game?: GameConfig) {
  const { sqlite } = handle;

  /**
   * A series: the class moves on to the School that continues this one, the
   * same students, still knowing what they were taught (their ledger stays).
   */
  app.post<{ Params: { id: string } }>("/api/classrooms/:id/move", async (req, reply) => {
    const body = z.object({ schoolId: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Move it to which School?" });
    const room = sqlite
      .prepare("SELECT id, name, school_id s FROM classrooms WHERE id = ? AND status != 'archived'")
      .get(req.params.id) as { id: string; name: string; s: string } | undefined;
    if (!room) return reply.code(404).send({ error: "no such class" });
    const to = sqlite
      .prepare("SELECT id, name FROM schools WHERE id = ? AND archived = 0")
      .get(body.data.schoolId) as { id: string; name: string } | undefined;
    if (!to) return reply.code(404).send({ error: "That School isn't there." });
    if (!seriesBefore(handle, to.id).some((x) => x.id === room.s))
      return reply.code(409).send({
        error: `${to.name} doesn't continue this class's School, so the class can't move there.`,
      });
    const open = sqlite
      .prepare("SELECT 1 FROM periods WHERE classroom_id = ? AND ended_at IS NULL")
      .get(room.id);
    if (open) return reply.code(409).send({ error: "End the class's lesson first, then move it." });
    const limit = game?.classroomsPerSchool ?? 3;
    const count = (
      sqlite
        .prepare("SELECT count(*) n FROM classrooms WHERE school_id = ? AND status != 'archived'")
        .get(to.id) as { n: number }
    ).n;
    if (count >= limit)
      return reply
        .code(409)
        .send({ error: `${to.name} already has ${count} classes, the most a School can have.` });
    sqlite
      .prepare("UPDATE classrooms SET school_id = ?, current_concept_id = NULL WHERE id = ?")
      .run(to.id, room.id);
    return { ok: true, classroomId: room.id, schoolId: to.id };
  });

  // V7-02: the class photo: who's in it (with their stickers), then the drawn SVG I keep.
  app.get<{ Params: { id: string } }>("/api/classrooms/:id/photo-data", async (req, reply) => {
    const room = sqlite
      .prepare(
        `SELECT c.name, c.status, s.name school, s.accent_color accent, c.photo_svg IS NOT NULL saved,
           (SELECT max(e.created_at) FROM exams e WHERE e.classroom_id = c.id) lastExam
         FROM classrooms c JOIN schools s ON s.id = c.school_id WHERE c.id = ?`,
      )
      .get(req.params.id) as
      | {
          name: string;
          status: string;
          school: string;
          accent: string | null;
          saved: number;
          lastExam: string | null;
        }
      | undefined;
    if (!room) return reply.code(404).send({ error: "no such class" });
    const students = (
      sqlite
        .prepare(
          "SELECT id, name, archetype, traits_json t FROM cadets WHERE classroom_id = ? AND status IN ('enrolled','transferred_in','alumni') ORDER BY seat",
        )
        .all(req.params.id) as Array<{ id: string; name: string; archetype: string; t: string }>
    ).map((c) => ({
      id: c.id,
      name: c.name,
      archetype: c.archetype,
      hair: hairOf(c.t),
      register: registerOf(c.id, c.t),
      stickers: (
        sqlite
          .prepare("SELECT kind FROM stickers WHERE cadet_id = ? ORDER BY created_at")
          .all(c.id) as Array<{
          kind: string;
        }>
      ).map((s) => s.kind),
    }));
    return {
      className: room.name,
      school: room.school,
      accent: room.accent,
      graduated: room.status === "graduated",
      saved: room.saved === 1,
      date: (room.lastExam ?? new Date().toISOString()).slice(0, 10),
      students,
    };
  });

  const PhotoZ = z.strictObject({ svg: z.string().min(50).max(3_000_000) });
  app.put<{ Params: { id: string } }>("/api/classrooms/:id/photo", async (req, reply) => {
    const body = PhotoZ.safeParse(req.body);
    // Our own drawing only: an SVG, no scripts or external references.
    if (
      !body.success ||
      !/^<svg[\s>]/.test(body.data.svg) ||
      /<script|on\w+=|javascript:/i.test(body.data.svg)
    )
      return reply.code(400).send({ error: "That isn't a class photo." });
    const r = sqlite
      .prepare("UPDATE classrooms SET photo_svg = ? WHERE id = ?")
      .run(body.data.svg, req.params.id);
    return r.changes ? { saved: true } : reply.code(404).send({ error: "no such class" });
  });

  app.get<{ Params: { id: string } }>("/api/classrooms/:id/photo.svg", async (req, reply) => {
    const row = sqlite
      .prepare("SELECT photo_svg s FROM classrooms WHERE id = ?")
      .get(req.params.id) as { s: string | null } | undefined;
    if (!row?.s) return reply.code(404).send({ error: "no photo yet" });
    return reply
      .type("image/svg+xml")
      .header(
        "content-security-policy",
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      )
      .send(row.s);
  });

  // V7-01: room upgrades, per classroom.
  if (game) {
    const exists = (id: string) =>
      !!sqlite.prepare("SELECT 1 FROM classrooms WHERE id = ?").get(id);
    app.get<{ Params: { id: string } }>("/api/classrooms/:id/upgrades", async (req, reply) =>
      exists(req.params.id)
        ? upgradeState(handle, game, req.params.id)
        : reply.code(404).send({ error: "no such class" }),
    );
    app.put<{ Params: { id: string; item: string } }>(
      "/api/classrooms/:id/upgrades/:item",
      async (req, reply) => {
        if (!exists(req.params.id)) return reply.code(404).send({ error: "no such class" });
        const r = placeUpgrade(handle, game, req.params.id, req.params.item);
        return "error" in r ? reply.code(409).send(r) : r;
      },
    );
    app.delete<{ Params: { id: string; item: string } }>(
      "/api/classrooms/:id/upgrades/:item",
      async (req, reply) =>
        exists(req.params.id)
          ? removeUpgrade(handle, game, req.params.id, req.params.item)
          : reply.code(404).send({ error: "no such class" }),
    );
  }

  /** V4-07: every student's hair and voice register, so each screen draws the same person. */
  app.get("/api/looks", async () => {
    const rows = sqlite.prepare("SELECT id, traits_json AS t FROM cadets").all() as Array<{
      id: string;
      t: string;
    }>;
    return Object.fromEntries(
      rows.map((r) => [r.id, { hair: hairOf(r.t), register: registerOf(r.id, r.t) }]),
    );
  });

  app.get("/api/schools", async () => {
    const schools = sqlite
      .prepare(
        `SELECT s.id, s.name, s.description, s.building_tier AS buildingTier, s.accent_color AS accent,
           CASE WHEN (SELECT status FROM assets a WHERE a.id = s.emblem_asset_id) = 'ready'
             THEN '/api/assets/' || s.emblem_asset_id END AS emblemUrl,
           (SELECT count(*) FROM sources x WHERE x.school_id = s.id AND x.status = 'ready') AS sources,
           (SELECT count(*) FROM concepts c JOIN modules m ON m.id = c.module_id WHERE m.school_id = s.id) AS concepts,
           s.continues_school_id AS continuesSchoolId
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

  // T-8: a cadet's own notes on what was taught (misconceptions and all).
  app.get<{ Params: { id: string } }>("/api/cadets/:id/notes", async (req, reply) => {
    const row = sqlite
      .prepare("SELECT id, name, archetype, notes_md AS notes FROM cadets WHERE id = ?")
      .get(req.params.id) as
      { id: string; name: string; archetype: string; notes: string } | undefined;
    return row ?? reply.code(404).send({ error: "no such cadet" });
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
