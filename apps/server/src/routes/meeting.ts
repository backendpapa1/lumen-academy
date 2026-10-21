import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ParentTurnZ, type GameConfig } from "@lumen/shared";
import { callStructured } from "../agents/harness.js";
import { loadPrompt } from "../agents/prompts/load.js";
import type { DbHandle } from "../db/client.js";
import { recall } from "../game/memory.js";
import type { ModelFactory } from "../models/factory.js";

// Parent–teacher meeting (V5-10): after a module, the parent of the student who
// struggled most asks me why. I explain their gaps with evidence (the ledger,
// their mix-ups, what they missed); the parent pushes back if I'm vague. The
// parent sees the evidence only, never the source.

const PARENTS = ["Mrs Adebayo-Clarke", "Mr Lindqvist", "Ms Okonkwo", "Mr Ferreira", "Mrs Haddad"];

interface Evidence {
  cadetId: string;
  childName: string;
  parentName: string;
  moduleTitle: string;
  lines: string[];
}

function evidence(
  handle: DbHandle,
  game: GameConfig,
  classroomId: string,
  moduleId?: string,
): Evidence | null {
  const { sqlite } = handle;
  const mod = (
    moduleId
      ? sqlite.prepare("SELECT id, title FROM modules WHERE id = ?").get(moduleId)
      : sqlite
          .prepare(
            `SELECT m.id, m.title FROM modules m JOIN classrooms c ON c.school_id = m.school_id
             JOIN concepts k ON k.module_id = m.id JOIN ledger_entries l ON l.concept_id = k.id
             WHERE c.id = ? GROUP BY m.id ORDER BY max(l.last_taught_at) DESC LIMIT 1`,
          )
          .get(classroomId)
  ) as { id: string; title: string } | undefined;
  if (!mod) return null;
  const concepts = sqlite
    .prepare("SELECT id, title FROM concepts WHERE module_id = ? ORDER BY ord")
    .all(mod.id) as Array<{ id: string; title: string }>;
  const students = sqlite
    .prepare(
      "SELECT id, name FROM cadets WHERE classroom_id = ? AND status IN ('enrolled','transferred_in','alumni')",
    )
    .all(classroomId) as Array<{ id: string; name: string }>;
  if (!students.length || !concepts.length) return null;
  const now = new Date();
  const level = (cadetId: string, conceptId: string) => {
    const r = sqlite
      .prepare(
        "SELECT comprehension c, last_taught_at at, stability_days st, misconceptions_json m, exposures n FROM ledger_entries WHERE cadet_id = ? AND concept_id = ?",
      )
      .get(cadetId, conceptId) as
      { c: number; at: string | null; st: number | null; m: string; n: number } | undefined;
    return {
      now: r ? recall(r.c, r.at, r.st, now, game.memory) : 0,
      taught: !!r && r.n > 0,
      mixups: r ? (JSON.parse(r.m) as Array<{ text: string }>).map((x) => x.text) : [],
    };
  };
  // The child who struggled most across the module.
  const child = students
    .map((s) => ({
      s,
      avg: concepts.reduce((a, c) => a + level(s.id, c.id).now, 0) / concepts.length,
    }))
    .sort((a, b) => a.avg - b.avg)[0]!.s;
  const lines = concepts.map((c) => {
    const l = level(child.id, c.id);
    return `- ${c.title}: ${l.taught ? `understands about ${Math.round(l.now * 100)}%` : "not taught yet"}${l.mixups.length ? `; believes: ${l.mixups.slice(0, 2).join("; ")}` : ""}`;
  });
  const misses = sqlite
    .prepare(
      `SELECT q.prompt FROM exam_results r JOIN exam_questions q ON q.id = r.question_id JOIN concepts k ON k.id = q.concept_id
       WHERE r.cadet_id = ? AND k.module_id = ? AND r.score < 0.5 LIMIT 3`,
    )
    .all(child.id, mod.id) as Array<{ prompt: string }>;
  if (misses.length)
    lines.push(`- Exam questions missed: ${misses.map((m) => `"${m.prompt}"`).join("; ")}`);
  return {
    cadetId: child.id,
    childName: child.name,
    parentName: PARENTS[child.id.length % PARENTS.length]!,
    moduleTitle: mod.title,
    lines,
  };
}

const TurnZ = z.strictObject({
  moduleId: z.string().optional(),
  history: z
    .array(z.strictObject({ who: z.enum(["parent", "teacher"]), text: z.string().max(2000) }))
    .max(12),
});

export function registerMeetingRoutes(
  app: FastifyInstance,
  deps: { handle: DbHandle; game: GameConfig; factory: ModelFactory },
) {
  /** Opens the meeting (empty history) or continues it. Stateless: the client keeps the history. */
  app.post<{ Params: { id: string } }>("/api/classrooms/:id/meeting", async (req, reply) => {
    if (!deps.game.modes.parentMeeting)
      return reply.code(409).send({ error: "Parent meetings are switched off in game.yaml." });
    const body = TurnZ.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad meeting turn" });
    const ev = evidence(deps.handle, deps.game, req.params.id, body.data.moduleId);
    if (!ev)
      return reply
        .code(409)
        .send({ error: "Teach a module first: there's nothing to discuss yet." });
    const history = body.data.history;
    try {
      const res = await callStructured(deps.factory, "parent", {
        schema: ParentTurnZ,
        name: "parent_turn",
        messages: [
          new SystemMessage(
            loadPrompt("parent", {
              parentName: ev.parentName,
              childName: ev.childName.split(" ")[0],
              moduleTitle: ev.moduleTitle,
              evidence: ev.lines.join("\n"),
              opening: history.length === 0,
            }),
          ),
          ...(history.length
            ? history.map((t) =>
                t.who === "parent" ? new AIMessage(t.text) : new HumanMessage(`Teacher: ${t.text}`),
              )
            : [new HumanMessage("(The teacher sits down across the desk.)")]),
        ],
      });
      return {
        parent: ev.parentName,
        child: { id: ev.cadetId, name: ev.childName },
        module: ev.moduleTitle,
        evidence: ev.lines,
        ...res.data,
      };
    } catch {
      return reply.code(502).send({ error: "The parent didn't answer this time. Try again." });
    }
  });
}
