import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DbHandle } from "../db/client.js";
import { newId } from "../db/ids.js";

// The parking lot (V3-04): a stray thought filed mid-class without leaving the
// flow. It comes back at the bell, where each one becomes a note to keep, a
// new concept for the curriculum, or is let go. Per School.

const AddZ = z.strictObject({
  text: z.string().trim().min(1).max(500),
  periodId: z.string().optional(),
});
const ResolveZ = z.strictObject({ status: z.enum(["open", "kept", "concept", "dismissed"]) });
const ListZ = z.object({
  status: z.enum(["open", "kept", "concept", "dismissed", "all"]).default("open"),
  periodId: z.string().optional(),
});

interface ParkedRow {
  id: string;
  text: string;
  status: string;
  periodId: string | null;
  createdAt: string;
}

export function registerParkingRoutes(app: FastifyInstance, deps: { handle: DbHandle }) {
  const { sqlite } = deps.handle;
  const schoolExists = (id: string) =>
    !!sqlite.prepare("SELECT 1 FROM schools WHERE id = ?").get(id);

  app.get<{ Params: { id: string } }>("/api/schools/:id/parking", async (req, reply) => {
    if (!schoolExists(req.params.id)) return reply.code(404).send({ error: "no such School" });
    const q = ListZ.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "bad query" });
    const where = ["school_id = @school"];
    if (q.data.status !== "all") where.push("status = @status");
    if (q.data.periodId) where.push("period_id = @period");
    return sqlite
      .prepare(
        `SELECT id, text, status, period_id AS periodId, created_at AS createdAt FROM parking_lot
         WHERE ${where.join(" AND ")} ORDER BY created_at`,
      )
      .all({
        school: req.params.id,
        status: q.data.status,
        period: q.data.periodId ?? null,
      }) as ParkedRow[];
  });

  app.post<{ Params: { id: string } }>("/api/schools/:id/parking", async (req, reply) => {
    if (!schoolExists(req.params.id)) return reply.code(404).send({ error: "no such School" });
    const body = AddZ.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Write the thought first." });
    const row: ParkedRow = {
      id: newId("parked"),
      text: body.data.text,
      status: "open",
      periodId: body.data.periodId ?? null,
      createdAt: new Date().toISOString(),
    };
    sqlite
      .prepare(
        "INSERT INTO parking_lot (id, school_id, period_id, text, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)",
      )
      .run(row.id, req.params.id, row.periodId, row.text, row.createdAt);
    const open = (
      sqlite
        .prepare("SELECT count(*) AS n FROM parking_lot WHERE school_id = ? AND status = 'open'")
        .get(req.params.id) as { n: number }
    ).n;
    return reply.code(201).send({ ...row, open });
  });

  app.patch<{ Params: { id: string } }>("/api/parking/:id", async (req, reply) => {
    const body = ResolveZ.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad status" });
    const done = body.data.status === "open" ? null : new Date().toISOString();
    const r = sqlite
      .prepare("UPDATE parking_lot SET status = ?, resolved_at = ? WHERE id = ?")
      .run(body.data.status, done, req.params.id);
    if (!r.changes) return reply.code(404).send({ error: "no such note" });
    return { id: req.params.id, status: body.data.status };
  });
}
