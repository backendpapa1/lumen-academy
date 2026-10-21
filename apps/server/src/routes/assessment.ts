import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createExam,
  debriefView,
  examEligibility,
  examQuestions,
  runExam,
  type ExamDeps,
} from "../game/exams.js";
import {
  assignmentView,
  createAssignment,
  gradeSubmission,
  taughtConceptIds,
} from "../game/homework.js";

// Assessment REST (docs/05 §6): the class's desk, assignments and grading,
// module exams and their results. Generation and collection run in the
// background and report over WS (assignment.status, exam.status/answer).

const CreateAssignmentZ = z.strictObject({
  conceptIds: z.array(z.string()).min(1).max(6),
  prompt: z.string().max(2000).optional(),
  title: z.string().max(120).optional(),
});
const GradeZ = z.strictObject({
  score: z.number().int().min(1).max(5),
  comment: z.string().max(2000),
});
const CreateExamZ = z.strictObject({ moduleId: z.string() });

export function registerAssessmentRoutes(app: FastifyInstance, deps: ExamDeps) {
  const { sqlite } = deps.handle;
  const classroom = (id: string) =>
    sqlite
      .prepare(
        "SELECT c.id, c.name, c.school_id AS schoolId, s.name AS schoolName FROM classrooms c JOIN schools s ON s.id = c.school_id WHERE c.id = ? AND c.status != 'archived'",
      )
      .get(id) as { id: string; name: string; schoolId: string; schoolName: string } | undefined;
  const fail = (
    reply: { code(n: number): { send(b: unknown): unknown } },
    err: unknown,
    code = 409,
  ) => reply.code(code).send({ error: (err as Error).message });

  app.get<{ Params: { id: string } }>("/api/classrooms/:id/desk", async (req, reply) => {
    const c = classroom(req.params.id);
    if (!c) return reply.code(404).send({ error: "no such classroom" });
    const taught = new Set(taughtConceptIds(deps.handle, c.id));
    const modules = (
      sqlite
        .prepare("SELECT id, title FROM modules WHERE school_id = ? ORDER BY ord")
        .all(c.schoolId) as Array<{ id: string; title: string }>
    ).map((m) => ({
      ...m,
      concepts: (
        sqlite
          .prepare("SELECT id, title FROM concepts WHERE module_id = ? ORDER BY ord")
          .all(m.id) as Array<{ id: string; title: string }>
      ).map((k) => ({ ...k, taught: taught.has(k.id) })),
      eligibility: (({ taught: t, total, fraction, eligible }) => ({
        taught: t,
        total,
        fraction,
        eligible,
      }))(examEligibility(deps.handle, c.id, m.id)),
    }));
    const assignments = sqlite
      .prepare(
        `SELECT a.id, a.title, a.status, a.created_at AS createdAt,
           (SELECT count(*) FROM submissions s WHERE s.assignment_id = a.id) AS submitted,
           (SELECT count(*) FROM submissions s WHERE s.assignment_id = a.id AND s.graded_at IS NOT NULL) AS graded
         FROM assignments a WHERE a.classroom_id = ? ORDER BY a.created_at DESC`,
      )
      .all(c.id);
    const exams = sqlite
      .prepare(
        `SELECT e.id, e.module_id AS moduleId, m.title AS moduleTitle, e.status, e.class_average AS classAverage, e.pass_threshold AS passThreshold, e.created_at AS createdAt
         FROM exams e JOIN modules m ON m.id = e.module_id WHERE e.classroom_id = ? ORDER BY e.created_at DESC`,
      )
      .all(c.id);
    const cadets = (
      sqlite
        .prepare(
          "SELECT count(*) AS n FROM cadets WHERE classroom_id = ? AND status IN ('enrolled','transferred_in')",
        )
        .get(c.id) as { n: number }
    ).n;
    return { classroom: c, cadets, modules, assignments, exams };
  });

  app.post<{ Params: { id: string } }>("/api/classrooms/:id/assignments", async (req, reply) => {
    const c = classroom(req.params.id);
    if (!c) return reply.code(404).send({ error: "no such classroom" });
    const body = CreateAssignmentZ.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Pick between one and six concepts." });
    try {
      return reply
        .code(202)
        .send(await createAssignment(deps, { classroomId: c.id, ...body.data }));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/api/assignments/:id", async (req, reply) => {
    const a = assignmentView(deps.handle, req.params.id);
    return a ?? reply.code(404).send({ error: "no such assignment" });
  });

  app.put<{ Params: { id: string } }>("/api/submissions/:id/grade", async (req, reply) => {
    const body = GradeZ.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "A grade is a whole number from 1 to 5." });
    try {
      return await gradeSubmission(deps, { submissionId: req.params.id, ...body.data });
    } catch (err) {
      return fail(reply, err, 400);
    }
  });

  app.post<{ Params: { id: string } }>("/api/classrooms/:id/exams", async (req, reply) => {
    const c = classroom(req.params.id);
    if (!c) return reply.code(404).send({ error: "no such classroom" });
    const body = CreateExamZ.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Pick a module." });
    try {
      return reply
        .code(202)
        .send(createExam(deps, { classroomId: c.id, moduleId: body.data.moduleId }));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/exams/:id/run", async (req, reply) => {
    const e = sqlite.prepare("SELECT status FROM exams WHERE id = ?").get(req.params.id) as
      { status: string } | undefined;
    if (!e) return reply.code(404).send({ error: "no such exam" });
    if (e.status !== "ready")
      return reply
        .code(409)
        .send({ error: e.status === "done" ? "This exam is over." : "The exam isn't ready yet." });
    void runExam(deps, req.params.id).catch(() => undefined); // progress and errors go out as exam.status
    return reply.code(202).send({ accepted: true });
  });

  app.get<{ Params: { id: string } }>("/api/exams/:id", async (req, reply) => {
    const e = sqlite
      .prepare(
        "SELECT e.id, e.classroom_id AS classroomId, e.module_id AS moduleId, m.title AS moduleTitle, e.status, e.class_average AS classAverage, e.pass_threshold AS passThreshold FROM exams e JOIN modules m ON m.id = e.module_id WHERE e.id = ?",
      )
      .get(req.params.id) as Record<string, unknown> | undefined;
    if (!e) return reply.code(404).send({ error: "no such exam" });
    // Answer keys stay server-side until the exam is over.
    const done = e.status === "done";
    const questions = examQuestions(deps.handle, req.params.id).map((q) =>
      done
        ? q
        : {
            id: q.id,
            ord: q.ord,
            kind: q.kind,
            prompt: q.prompt,
            options: q.options,
            conceptId: q.conceptId,
            conceptTitle: q.conceptTitle,
          },
    );
    const results = sqlite
      .prepare(
        "SELECT question_id AS questionId, cadet_id AS cadetId, answer, score FROM exam_results WHERE exam_id = ?",
      )
      .all(req.params.id);
    return { ...e, questions, results };
  });

  app.get<{ Params: { id: string } }>("/api/exams/:id/results", async (req, reply) => {
    const d = debriefView(deps.handle, deps.game, req.params.id);
    return d ?? reply.code(404).send({ error: "no such exam" });
  });
}
