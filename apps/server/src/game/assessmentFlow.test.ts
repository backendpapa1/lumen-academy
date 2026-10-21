import { afterEach, describe, expect, it } from "vitest";
import type { Broadcast } from "../events.js";
import { EventBus } from "../events.js";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { agentOf, fakeDeepSeekFactory, type FakeRequest } from "../test-fixtures/fakeDeepSeek.js";
import { smallWorld } from "../test-fixtures/world.js";
import { questionProblems, type ExamConcept } from "../agents/examiner.js";
import { createExam, debriefView, examEligibility, pickedOption, runExam } from "./exams.js";
import { finishExitTickets, issueExitTickets, markExitTicket } from "./exitTickets.js";
import { assignmentView, createAssignment, gradeSubmission, reactionLine } from "./homework.js";
import { schoolConceptStatuses } from "./schoolStatus.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());

const until = async (pred: () => boolean, ms = 4000) => {
  for (let t = 0; t < ms; t += 10) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
};

/** A world where cadet 0 understood Merkle Trees well and cadet 1 not at all. */
async function world() {
  const w = await smallWorld([
    { attention: 0.9, skepticism: 0.5 },
    { attention: 0.4, skepticism: 0.2 },
  ]);
  h = w.handle;
  const chunk = (h.sqlite.prepare("SELECT id FROM chunks ORDER BY ord").get() as { id: string }).id;
  const [merkle, header] = w.conceptIds as [string, string];
  // Teaching happened: the Director credited facts, the ledger moved.
  const per = h.sqlite.prepare(
    "INSERT INTO periods (id, classroom_id, started_at, planned_minutes) VALUES ('per_1', ?, '2026-10-21T00:00:00Z', 15)",
  );
  per.run(w.classroomId);
  h.sqlite
    .prepare(
      "INSERT INTO messages (id, period_id, speaker, kind, text, created_at) VALUES ('msg_1','per_1','teacher','lecture','x','2026-10-21T00:00:00Z')",
    )
    .run();
  const analysis = {
    conceptIds: [merkle],
    teaching: {
      accuracy: 1,
      clarity: 1,
      coverage: ["Merkle Trees a", "Merkle Trees b", "Merkle Trees c"],
      errors: [],
    },
    ledgerDeltas: [],
  };
  h.sqlite
    .prepare(
      "INSERT INTO turns (id, period_id, ord, teacher_message_id, analysis_json, reactions_json, created_at) VALUES ('trn_1','per_1',1,'msg_1',?, '{}', '2026-10-21T00:00:00Z')",
    )
    .run(JSON.stringify(analysis));
  h.sqlite
    .prepare(
      "INSERT INTO teacher_errors (id, turn_id, concept_id, claim, correction, citation) VALUES ('ter_1','trn_1',?,'The root is in every transaction.','Header only.','kf1')",
    )
    .run(merkle);
  const led = h.sqlite.prepare(
    "INSERT INTO ledger_entries (cadet_id, concept_id, comprehension, exposures, misconceptions_json) VALUES (?, ?, ?, ?, ?)",
  );
  led.run(w.cadets[0]!.id, merkle, 1, 6, "[]");
  led.run(
    w.cadets[1]!.id,
    merkle,
    0,
    6,
    JSON.stringify([
      { text: "The root is in every transaction.", source: "teacher_error", since: "x" },
    ]),
  );
  led.run(w.cadets[0]!.id, header, 0.8, 3, "[]");
  led.run(w.cadets[1]!.id, header, 0.2, 3, "[]");
  return { w, chunk, merkle, header };
}

/** Scripted models: the Examiner cites the real chunk; cadets answer from their pack; the Grader scores by keyword. */
function models(chunk: string, merkle: string, header: string) {
  return (body: FakeRequest) => {
    const who = agentOf(body);
    const last = body.messages.at(-1)!.content;
    if (who === "examiner") {
      const exam = body.messages.some((m) => m.content.includes("a module exam"));
      const q = (conceptId: string, i: number) =>
        exam && i % 2 === 0
          ? {
              kind: "mcq",
              conceptId,
              prompt: `Question ${i} about pairs?`,
              options: ["Pairs are hashed", "Nothing", "Coins", "Blocks"],
              answerKey: "Pairs are hashed",
              rubric: ["Pairs are hashed up to a root"],
              citations: [chunk],
            }
          : {
              kind: "short",
              conceptId,
              prompt: `Explain question ${i}, please.`,
              answerKey: "Pairs are hashed up to a root.",
              rubric: ["Pairs are hashed up to a root"],
              citations: [chunk],
            };
      const n = exam ? 6 : 3;
      return JSON.stringify({
        questions: Array.from({ length: n }, (_, i) => q(i % 2 ? header : merkle, i)),
      });
    }
    if (who === "cadetAnswer") {
      const knows =
        body.messages[0]!.content.includes("Merkle Trees a") ||
        body.messages[1]?.content.includes("Merkle Trees a");
      const sys = body.messages.map((m) => m.content).join("\n");
      const retained = sys.includes("- Merkle Trees a");
      if (last.includes("A)"))
        return JSON.stringify({
          answer: retained ? "A) Pairs are hashed" : "B) Nothing",
          confidence: 0.7,
        });
      return JSON.stringify({
        answer: retained || knows ? "Pairs are hashed up to a root." : "I don't remember.",
        confidence: 0.6,
      });
    }
    if (who === "grader") {
      const good = last.includes("Pairs are hashed");
      return JSON.stringify({
        score: good ? 5 : 1,
        present: [],
        missing: [],
        contradictions: [],
        rationale: good ? "Right." : "Missing.",
      });
    }
    if (who === "classDirector")
      return JSON.stringify({
        conceptIds: [merkle],
        teaching: { accuracy: 1, clarity: 0.9, coverage: [], errors: [] },
        ledgerDeltas: [],
      });
    if (who === "debriefAnalyst")
      return JSON.stringify({
        strengths: ["Merkle pairing landed."],
        gaps: ["Headers need work."],
        plan: [
          { conceptId: header, step: "Explain where the root sits." },
          { conceptId: "cpt_bogus", step: "x" },
        ],
      });
    return "{}";
  };
}

describe("examiner validation", () => {
  const concepts: ExamConcept[] = [
    {
      id: "cpt_a",
      title: "A",
      keyFacts: ["f"],
      misconceptions: [],
      passages: [{ id: "chk_1", text: "t" }],
    },
  ];
  const base = {
    conceptId: "cpt_a",
    prompt: "What is A really?",
    answerKey: "x",
    rubric: ["f"],
    citations: ["chk_1"],
  };
  it("accepts a grounded question and rejects wrong concepts, foreign citations and bad mcqs", () => {
    expect(questionProblems({ ...base, kind: "short" }, concepts, "assignment")).toEqual([]);
    expect(
      questionProblems({ ...base, kind: "short", conceptId: "cpt_z" }, concepts, "exam")[0],
    ).toMatch(/not one of/);
    expect(
      questionProblems({ ...base, kind: "short", citations: ["chk_9"] }, concepts, "exam")[0],
    ).toMatch(/not passages/);
    expect(
      questionProblems({ ...base, kind: "mcq", options: ["a", "b", "c"] }, concepts, "exam")[0],
    ).toMatch(/4 different/);
    expect(
      questionProblems(
        { ...base, kind: "mcq", options: ["a", "b", "c", "d"] },
        concepts,
        "exam",
      )[0],
    ).toMatch(/answerKey/);
    expect(
      questionProblems(
        { ...base, kind: "mcq", options: ["x", "b", "c", "d"] },
        concepts,
        "assignment",
      )[0],
    ).toMatch(/not mcq/);
  });
  it("reads which mcq option an answer picked", () => {
    const opts = ["Pairs are hashed", "Nothing", "Coins", "Blocks"];
    expect(pickedOption("B) nothing at all", opts)).toBe(1);
    expect(pickedOption("I think pairs are hashed.", opts)).toBe(0);
    expect(pickedOption("no idea", opts)).toBeNull();
  });
});

describe("assignments (A-1..A-5)", () => {
  it("drafts, collects answers that mirror the ledger, reference-grades, and learns from feedback", async () => {
    const { w, chunk, merkle, header } = await world();
    const bus = new EventBus();
    const events: Broadcast[] = [];
    bus.on((m) => events.push(m));
    const { factory } = fakeDeepSeekFactory(cfg.models, models(chunk, merkle, header));
    const deps = { handle: h!, factory, game: cfg.game, bus };
    const { assignmentId, questions } = await createAssignment(deps, {
      classroomId: w.classroomId,
      conceptIds: [merkle, header],
    });
    expect(questions).toBe(3);
    await until(() =>
      events.some((e) => e.type === "assignment.status" && e.payload.status === "submitted"),
    );
    const a = assignmentView(h!, assignmentId)!;
    expect(a.status).toBe("submitted");
    expect(a.questions.every((q) => q.citations.includes(chunk))).toBe(true);
    const [strong, weak] = a.submissions;
    expect(strong!.refScore!).toBeGreaterThan(weak!.refScore!); // the mirror: ledger → answers → grades

    const before = (
      h!.sqlite
        .prepare("SELECT comprehension FROM ledger_entries WHERE cadet_id = ? AND concept_id = ?")
        .get(weak!.cadetId, merkle) as { comprehension: number }
    ).comprehension;
    const r = await gradeSubmission(deps, {
      submissionId: weak!.id,
      score: 2,
      comment: "The root sits in the block header, not in every transaction.",
    });
    expect(r.reaction).toMatch(/^Cadet:/);
    const after = (
      h!.sqlite
        .prepare("SELECT comprehension FROM ledger_entries WHERE cadet_id = ? AND concept_id = ?")
        .get(weak!.cadetId, merkle) as { comprehension: number }
    ).comprehension;
    expect(after).toBeGreaterThanOrEqual(before); // feedback is a learning event
    expect(assignmentView(h!, assignmentId)!.submissions[1]).toMatchObject({
      myScore: 2,
      reaction: r.reaction,
    });
    const xp = h!.sqlite
      .prepare("SELECT sum(amount) AS n FROM xp_events WHERE kind = 'submissionGraded'")
      .get() as { n: number };
    expect(xp.n).toBe(cfg.game.xp.submissionGraded);
    await gradeSubmission(deps, { submissionId: strong!.id, score: 5, comment: "" });
    expect(assignmentView(h!, assignmentId)!.status).toBe("graded");
    await expect(
      gradeSubmission(deps, { submissionId: strong!.id, score: 9, comment: "" }),
    ).rejects.toThrow(/1–5/);
  });

  it("reactions follow the grade and notice harsh marking", () => {
    expect(reactionLine({ name: "Ines Vale", archetype: "skeptic" }, 5, 4)).toMatch(/^Ines: /);
    expect(reactionLine({ name: "Ines Vale", archetype: "skeptic" }, 1, 4.5)).toMatch(/harsh/);
  });
});

describe("exams (E-1..E-5)", () => {
  it("needs 70% taught, generates, runs with streamed answers, auto-grades, and debriefs", async () => {
    const { w, chunk, merkle, header } = await world();
    const moduleId = (
      h!.sqlite.prepare("SELECT module_id FROM concepts WHERE id = ?").get(merkle) as {
        module_id: string;
      }
    ).module_id;
    expect(examEligibility(h!, w.classroomId, moduleId)).toMatchObject({
      taught: 2,
      total: 2,
      eligible: true,
    });
    const bus = new EventBus();
    const events: Broadcast[] = [];
    bus.on((m) => events.push(m));
    const { factory } = fakeDeepSeekFactory(cfg.models, models(chunk, merkle, header));
    const deps = { handle: h!, factory, game: cfg.game, bus };
    const { examId } = createExam(deps, { classroomId: w.classroomId, moduleId });
    await until(() => events.some((e) => e.type === "exam.status" && e.payload.status === "ready"));
    await runExam(deps, examId);
    const answers = events.filter((e) => e.type === "exam.answer");
    expect(answers).toHaveLength(5 * 2); // two concepts → 5 questions (the Examiner wrote 6; extras dropped)
    const d = debriefView(h!, cfg.game, examId)!;
    const merkleResult = d.concepts.find((c) => c.conceptId === merkle)!;
    expect(merkleResult.score).toBeGreaterThan(0.4);
    expect(d.heatmap[0]!.scores[merkle]!).toBeGreaterThan(d.heatmap[1]!.scores[merkle]!);
    expect(d.teacherErrors.map((e) => e.claim)).toEqual(["The root is in every transaction."]);
    expect(d.analysis?.plan.map((p) => p.conceptId)).toEqual([header]); // unknown concept ids dropped
    expect(merkleResult.references[0]).toMatchObject({ chunkId: chunk });
    expect(events.at(-1)).toMatchObject({ type: "exam.status", payload: { status: "done" } });
    // E-5: statuses now include exam results.
    const st = schoolConceptStatuses(h!, w.schoolId, cfg.game.status);
    expect(Object.keys(st)).toContain(header);
    await expect(runExam(deps, examId)).rejects.toThrow(/over/);
  });

  it("refuses an exam before 70% of the module is taught", async () => {
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    h = w.handle;
    const moduleId = (
      h.sqlite.prepare("SELECT module_id FROM concepts LIMIT 1").get() as { module_id: string }
    ).module_id;
    const { factory } = fakeDeepSeekFactory(cfg.models, () => "{}");
    expect(() =>
      createExam({ handle: h!, factory, game: cfg.game }, { classroomId: w.classroomId, moduleId }),
    ).toThrow(/70%/);
  });
});

describe("exit tickets (M4-05)", () => {
  it("states retained facts or held misconceptions; ✗ on a misconception corrects it; XP once", async () => {
    const { w, merkle } = await world();
    const tickets = issueExitTickets(h!, {
      periodId: "per_1",
      classroomId: w.classroomId,
      conceptId: merkle,
    });
    expect(tickets).toHaveLength(2);
    const weakTicket = tickets.find((t) => t.cadetId === w.cadets[1]!.id)!;
    expect(weakTicket.statement).toBe("The root is in every transaction."); // it retained nothing true
    const r = markExitTicket(h!, { ticketId: weakTicket.id, verdict: false })!;
    expect(r).toMatchObject({ right: true, isTrue: false, corrected: true });
    const held = h!.sqlite
      .prepare(
        "SELECT misconceptions_json FROM ledger_entries WHERE cadet_id = ? AND concept_id = ?",
      )
      .get(w.cadets[1]!.id, merkle) as { misconceptions_json: string };
    expect(JSON.parse(held.misconceptions_json)).toEqual([]);
    const strong = tickets.find((t) => t.cadetId === w.cadets[0]!.id)!;
    expect(markExitTicket(h!, { ticketId: strong.id, verdict: true })).toMatchObject({
      right: true,
      isTrue: true,
    });
    const scope = { schoolId: w.schoolId, classroomId: w.classroomId, periodId: "per_1" };
    expect(finishExitTickets(h!, cfg.game, scope)).toMatchObject({
      marked: 2,
      total: 2,
      right: 2,
      xp: cfg.game.xp.exitTicketComplete,
    });
    expect(finishExitTickets(h!, cfg.game, scope).xp).toBe(0);
  });
});
