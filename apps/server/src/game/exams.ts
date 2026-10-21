import { rivalFor } from "./rival.js";
import { peekedRecently } from "./sourceCheck.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  DebriefContentZ,
  type Archetype,
  type DebriefView,
  type GameConfig,
  type QuestionView,
} from "@lumen/shared";
import { answerQuestion, gradeAnswer } from "../agents/assessment.js";
import { classWeakSpots, draftQuestions, loadExamConcepts } from "../agents/examiner.js";
import { callStructured } from "../agents/harness.js";
import { loadPrompt } from "../agents/prompts/load.js";
import type { AssetService } from "../assets/service.js";
import type { DbHandle } from "../db/client.js";
import { checkGraduation, refreshTiers } from "./campus.js";
import { newId } from "../db/ids.js";
import type { EventBus } from "../events.js";
import type { ModelFactory } from "../models/factory.js";
import { cadetPack } from "./packs.js";
import { pool } from "./pool.js";
import { awardXp } from "./xp.js";

// Module exams (E-1..E-5): eligibility, Examiner questions, the arena run
// (answers stream to the client as they're graded), auto-grading against the
// source, XP, and the Debrief.

export interface ExamDeps {
  handle: DbHandle;
  factory: ModelFactory;
  game: GameConfig;
  bus?: EventBus;
  /** For tier-up facade decals. */
  assets?: AssetService;
}

/** E-1: `unlock` is the share of the module's concepts that must be taught (game.yaml exam.unlockTaughtFraction). */
export function examEligibility(
  handle: DbHandle,
  classroomId: string,
  moduleId: string,
  unlock: number,
) {
  const rows = handle.sqlite
    .prepare(
      `SELECT c.id, (SELECT avg(l.exposures) FROM ledger_entries l JOIN cadets d ON d.id = l.cadet_id
                      WHERE l.concept_id = c.id AND d.classroom_id = ?) AS turns
       FROM concepts c WHERE c.module_id = ? ORDER BY c.ord`,
    )
    .all(classroomId, moduleId) as Array<{ id: string; turns: number | null }>;
  const taught = rows.filter((r) => (r.turns ?? 0) > 0).length;
  const fraction = rows.length ? taught / rows.length : 0;
  return {
    taught,
    total: rows.length,
    fraction,
    eligible: fraction >= unlock,
    conceptIds: rows.map((r) => r.id),
  };
}

/** E-1 + E-2: checks eligibility, then generates questions in the background. */
export function createExam(
  deps: ExamDeps,
  input: { classroomId: string; moduleId: string; force?: boolean },
): { examId: string } {
  const { passThreshold, unlockTaughtFraction } = deps.game.exam;
  const e = examEligibility(deps.handle, input.classroomId, input.moduleId, unlockTaughtFraction);
  if (!e.eligible && !input.force)
    throw new Error(
      `Teach at least ${Math.round(unlockTaughtFraction * 100)}% of this module first (${e.taught} of ${e.total} concepts so far).`,
    );
  const examId = newId("exam");
  // V6-06: an exam right after I checked my sources is an open-book one.
  const schoolId = (
    deps.handle.sqlite
      .prepare("SELECT school_id s FROM classrooms WHERE id = ?")
      .get(input.classroomId) as { s: string } | undefined
  )?.s;
  const openBook = schoolId ? peekedRecently(deps.handle, schoolId) : false;
  deps.handle.sqlite
    .prepare(
      "INSERT INTO exams (id, classroom_id, module_id, status, pass_threshold, open_book, created_at) VALUES (?, ?, ?, 'generating', ?, ?, ?)",
    )
    .run(
      examId,
      input.classroomId,
      input.moduleId,
      passThreshold,
      openBook ? 1 : 0,
      new Date().toISOString(),
    );
  const emit = (status: "generating" | "ready" | "error", detail?: string) =>
    deps.bus?.emit({
      type: "exam.status",
      payload: { examId, classroomId: input.classroomId, status, ...(detail ? { detail } : {}) },
    });
  emit("generating");
  void (async () => {
    const concepts = loadExamConcepts(deps.handle, e.conceptIds);
    const res = await draftQuestions(deps.factory, {
      kind: "exam",
      count: Math.min(12, Math.max(5, concepts.length * 2)),
      concepts,
      weakSpots: classWeakSpots(deps.handle, input.classroomId, concepts),
    });
    const ins = deps.handle.sqlite.prepare(
      `INSERT INTO exam_questions (id, exam_id, ord, kind, prompt, options_json, answer_key, rubric, concept_id, citations_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    deps.handle.sqlite.transaction(() => {
      res.questions.forEach((q, i) =>
        ins.run(
          newId("examQuestion"),
          examId,
          i + 1,
          q.kind,
          q.prompt,
          q.options ? JSON.stringify(q.options) : null,
          q.answerKey,
          JSON.stringify(q.rubric),
          q.conceptId,
          JSON.stringify(q.citations),
        ),
      );
    })();
    deps.handle.sqlite.prepare("UPDATE exams SET status = 'ready' WHERE id = ?").run(examId);
    emit("ready");
  })().catch((err: unknown) => {
    deps.handle.sqlite.prepare("DELETE FROM exams WHERE id = ?").run(examId);
    emit("error", (err as Error).message);
  });
  return { examId };
}

export function examQuestions(handle: DbHandle, examId: string): QuestionView[] {
  return (
    handle.sqlite
      .prepare(
        `SELECT q.id, q.ord, q.kind, q.prompt, q.options_json, q.answer_key, q.rubric, q.concept_id, q.citations_json, c.title
         FROM exam_questions q JOIN concepts c ON c.id = q.concept_id WHERE q.exam_id = ? ORDER BY q.ord`,
      )
      .all(examId) as Array<{
      id: string;
      ord: number;
      kind: QuestionView["kind"];
      prompt: string;
      options_json: string | null;
      answer_key: string;
      rubric: string;
      concept_id: string;
      citations_json: string;
      title: string;
    }>
  ).map((r) => ({
    id: r.id,
    ord: r.ord,
    kind: r.kind,
    prompt: r.prompt,
    ...(r.options_json ? { options: JSON.parse(r.options_json) as string[] } : {}),
    answerKey: r.answer_key,
    rubric: JSON.parse(r.rubric) as string[],
    conceptId: r.concept_id,
    citations: JSON.parse(r.citations_json) as string[],
    conceptTitle: r.title,
  }));
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Which option an mcq answer picked: a leading letter, or the option text it contains. */
export function pickedOption(answer: string, options: string[]): number | null {
  const letter = /^\s*\(?([A-D])[).:\s]/i.exec(answer);
  if (letter) return "ABCD".indexOf(letter[1]!.toUpperCase());
  const a = norm(answer);
  const hits = options
    .map((o, i) => [i, norm(o)] as const)
    .filter(([, o]) => o.length > 3 && a.includes(o));
  if (hits.length === 1) return hits[0]![0];
  // Longest overlapping option wins when several are quoted.
  return hits.length ? hits.sort((x, y) => y[1].length - x[1].length)[0]![0] : null;
}

/** E-3: every cadet answers every question; graded answers stream out as they land. */
export async function runExam(deps: ExamDeps, examId: string): Promise<void> {
  const { handle } = deps;
  const exam = handle.sqlite
    .prepare("SELECT classroom_id, module_id, status FROM exams WHERE id = ?")
    .get(examId) as { classroom_id: string; module_id: string; status: string } | undefined;
  if (!exam) throw new Error("no such exam");
  if (exam.status !== "ready")
    throw new Error(exam.status === "done" ? "this exam is over" : "the exam isn't ready yet");
  handle.sqlite.prepare("UPDATE exams SET status = 'running' WHERE id = ?").run(examId);
  const emit = (status: "running" | "done" | "error", detail?: string) =>
    deps.bus?.emit({
      type: "exam.status",
      payload: { examId, classroomId: exam.classroom_id, status, ...(detail ? { detail } : {}) },
    });
  emit("running");
  const questions = examQuestions(handle, examId);
  const cadets = handle.sqlite
    .prepare(
      "SELECT id, name, homeworld, archetype, voice_notes, traits_json FROM cadets WHERE classroom_id = ? AND status IN ('enrolled','transferred_in') ORDER BY seat",
    )
    .all(exam.classroom_id) as Array<{
    id: string;
    name: string;
    homeworld: string;
    archetype: Archetype;
    voice_notes: string;
    traits_json: string;
  }>;
  const concepts = loadExamConcepts(handle, [...new Set(questions.map((q) => q.conceptId))]);
  const insert = handle.sqlite.prepare(
    "INSERT OR REPLACE INTO exam_results (exam_id, question_id, cadet_id, answer, score, rationale) VALUES (?, ?, ?, ?, ?, ?)",
  );
  let sum = 0;
  let n = 0;
  try {
    // Question by question, like an exam hall; cadets answer each in parallel.
    for (const q of questions) {
      const concept = concepts.find((c) => c.id === q.conceptId)!;
      await pool(cadets, 5, async (cadet) => {
        const pack = cadetPack(handle, {
          classroomId: exam.classroom_id,
          cadetId: cadet.id,
          concept: { id: concept.id, title: concept.title, keyFacts: concept.keyFacts },
          purpose: `exam:${examId}`,
          memory: deps.game.memory,
        });
        const asked =
          q.kind === "mcq"
            ? `${q.prompt}\n${q.options!.map((o, i) => `${"ABCD"[i]}) ${o}`).join("\n")}\nStart your answer with the letter you choose.`
            : q.kind === "eli10"
              ? `Explain like I'm 10: ${q.prompt}`
              : q.prompt;
        const traits = JSON.parse(cadet.traits_json) as { confidence?: number };
        const ans = await answerQuestion(
          deps.factory,
          {
            name: cadet.name,
            homeworld: cadet.homeworld,
            archetype: cadet.archetype,
            voiceNotes: cadet.voice_notes,
            confidence: traits.confidence ?? 0.5,
          },
          [pack],
          asked,
          { purpose: "exam", maxWords: q.kind === "mcq" ? 40 : 70 },
        ).catch(() => ({ answer: "(no answer)", confidence: 0 }));
        let score: number;
        let rationale: string;
        if (q.kind === "mcq") {
          const pick = pickedOption(ans.answer, q.options!);
          score = pick !== null && q.options![pick]!.trim() === q.answerKey.trim() ? 1 : 0;
          rationale = pick === null ? "No option chosen." : `Chose ${"ABCD"[pick]}.`;
        } else {
          const g = await gradeAnswer(
            deps.factory,
            q.prompt,
            [...q.rubric, q.answerKey],
            ans.answer,
          ).catch(() => null);
          score = g ? g.score / 5 : 0;
          rationale = g?.rationale ?? "Couldn't be graded.";
        }
        insert.run(examId, q.id, cadet.id, ans.answer, score, rationale);
        sum += score;
        n++;
        deps.bus?.emit({
          type: "exam.answer",
          payload: {
            examId,
            questionId: q.id,
            ord: q.ord,
            cadetId: cadet.id,
            score,
            integrity: sum / n,
          },
        });
      });
    }
  } catch (err) {
    handle.sqlite.prepare("UPDATE exams SET status = 'ready' WHERE id = ?").run(examId);
    emit("error", (err as Error).message);
    throw err;
  }
  const avg = n ? sum / n : 0;
  handle.sqlite
    .prepare("UPDATE exams SET status = 'done', class_average = ? WHERE id = ?")
    .run(avg, examId);
  const schoolId = (
    handle.sqlite
      .prepare("SELECT school_id FROM classrooms WHERE id = ?")
      .get(exam.classroom_id) as { school_id: string }
  ).school_id;
  // docs/02 §7.1: exam pass = 200 × average score.
  if (avg >= deps.game.exam.passThreshold)
    awardXp(
      handle,
      deps.game,
      { schoolId, classroomId: exam.classroom_id, periodId: null },
      "examPassPerAvgScore",
      avg,
    );
  await writeDebrief(deps, examId).catch(() => undefined);
  // P-4 + tiers: a passed final module may graduate the class and lift the wing.
  checkGraduation(handle, exam.classroom_id);
  refreshTiers(handle, deps.game, deps.assets);
  emit("done");
}

/** E-4: the numbers, then a short written analysis. Stored; re-computed on read. */
export async function writeDebrief(deps: ExamDeps, examId: string): Promise<void> {
  const view = debriefView(deps.handle, deps.game, examId, null);
  if (!view) return;
  const concepts = loadExamConcepts(
    deps.handle,
    view.concepts.map((c) => c.conceptId),
  );
  const system = loadPrompt("debriefAnalyst", {
    moduleTitle: view.moduleTitle,
    classAverage: `${Math.round(view.classAverage * 100)}%`,
    passMark: `${Math.round(view.passThreshold * 100)}%`,
    concepts: view.concepts
      .map((c) => {
        const k = concepts.find((x) => x.id === c.conceptId)!;
        return `${c.conceptId} | ${c.title} | ${Math.round(c.score * 100)}% | ${c.turns.toFixed(1)} | ${k.keyFacts.join(" / ")}`;
      })
      .join("\n"),
    errors: view.teacherErrors.map((e) => `- "${e.claim}" (source: ${e.correction})`).join("\n"),
  });
  const res = await callStructured(deps.factory, "debriefAnalyst", {
    schema: DebriefContentZ,
    name: "debrief",
    messages: [new SystemMessage(system), new HumanMessage("Write the debrief.")],
  });
  const known = new Set(view.concepts.map((c) => c.conceptId));
  const content = { ...res.data, plan: res.data.plan.filter((p) => known.has(p.conceptId)) };
  const exam = deps.handle.sqlite
    .prepare("SELECT classroom_id FROM exams WHERE id = ?")
    .get(examId) as { classroom_id: string };
  deps.handle.sqlite
    .prepare(
      "INSERT INTO debriefs (id, classroom_id, exam_id, content_json, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      newId("debrief"),
      exam.classroom_id,
      examId,
      JSON.stringify(content),
      new Date().toISOString(),
    );
}

export function debriefView(
  handle: DbHandle,
  game: GameConfig,
  examId: string,
  analysis?: DebriefView["analysis"] | null,
): DebriefView | null {
  const { sqlite } = handle;
  const exam = sqlite
    .prepare(
      "SELECT e.classroom_id, e.module_id, e.pass_threshold, e.class_average, e.open_book, m.title FROM exams e JOIN modules m ON m.id = e.module_id WHERE e.id = ?",
    )
    .get(examId) as
    | {
        classroom_id: string;
        module_id: string;
        pass_threshold: number;
        open_book: number;
        class_average: number | null;
        title: string;
      }
    | undefined;
  if (!exam) return null;
  const results = sqlite
    .prepare(
      `SELECT r.cadet_id, r.score, q.concept_id FROM exam_results r JOIN exam_questions q ON q.id = r.question_id WHERE r.exam_id = ?`,
    )
    .all(examId) as Array<{ cadet_id: string; score: number; concept_id: string }>;
  const conceptRows = sqlite
    .prepare("SELECT id, title FROM concepts WHERE module_id = ? ORDER BY ord")
    .all(exam.module_id) as Array<{ id: string; title: string }>;
  const examined = conceptRows.filter((c) => results.some((r) => r.concept_id === c.id));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const concepts = examined.map((c) => {
    const score = mean(results.filter((r) => r.concept_id === c.id).map((r) => r.score));
    const turns =
      (
        sqlite
          .prepare(
            "SELECT avg(l.exposures) AS t FROM ledger_entries l JOIN cadets d ON d.id = l.cadet_id WHERE l.concept_id = ? AND d.classroom_id = ?",
          )
          .get(c.id, exam.classroom_id) as { t: number | null }
      ).t ?? 0;
    const refs = sqlite
      .prepare(
        "SELECT ch.id, ch.heading_path, ch.page_from, ch.text FROM concept_citations cc JOIN chunks ch ON ch.id = cc.chunk_id WHERE cc.concept_id = ? ORDER BY ch.ord LIMIT 3",
      )
      .all(c.id) as Array<{
      id: string;
      heading_path: string | null;
      page_from: number | null;
      text: string;
    }>;
    return {
      conceptId: c.id,
      title: c.title,
      score,
      turns,
      // Under-taught: the class missed it and it got little teaching time (E-4).
      underTaught: score < exam.pass_threshold && turns < game.status.weakMinExposures,
      references: refs.map((r) => ({
        chunkId: r.id,
        where:
          [
            r.heading_path ? r.heading_path.split(" > ").join(" › ") : null,
            r.page_from ? `p. ${r.page_from}` : null,
          ]
            .filter(Boolean)
            .join(", ") || "Source",
        excerpt: r.text.replace(/\s+/g, " ").slice(0, 220),
      })),
    };
  });
  const cadets = sqlite
    .prepare(
      "SELECT id, name FROM cadets WHERE classroom_id = ? AND status IN ('enrolled','transferred_in') ORDER BY seat",
    )
    .all(exam.classroom_id) as Array<{ id: string; name: string }>;
  const heatmap = cadets.map((c) => ({
    cadetId: c.id,
    name: c.name,
    scores: Object.fromEntries(
      examined.map((k) => [
        k.id,
        mean(
          results.filter((r) => r.cadet_id === c.id && r.concept_id === k.id).map((r) => r.score),
        ),
      ]),
    ),
  }));
  const errors = sqlite
    .prepare(
      `SELECT te.claim, te.correction, te.citation, c.title AS conceptTitle FROM teacher_errors te
       JOIN turns t ON t.id = te.turn_id JOIN periods p ON p.id = t.period_id
       LEFT JOIN concepts c ON c.id = te.concept_id
       WHERE p.classroom_id = ? AND (te.concept_id IS NULL OR c.module_id = ?) ORDER BY t.created_at`,
    )
    .all(exam.classroom_id, exam.module_id) as DebriefView["teacherErrors"];
  const stored =
    analysis !== undefined && analysis !== null
      ? analysis
      : (() => {
          const row = sqlite
            .prepare(
              "SELECT content_json FROM debriefs WHERE exam_id = ? ORDER BY created_at DESC LIMIT 1",
            )
            .get(examId) as { content_json: string } | undefined;
          return row ? DebriefContentZ.parse(JSON.parse(row.content_json)) : null;
        })();
  const classAverage = exam.class_average ?? mean(results.map((r) => r.score));
  const xp = (
    sqlite
      .prepare(
        "SELECT coalesce(sum(amount),0) AS n FROM xp_events WHERE kind = 'examPassPerAvgScore' AND classroom_id = ? AND ts >= (SELECT created_at FROM exams WHERE id = ?)",
      )
      .get(exam.classroom_id, examId) as { n: number }
  ).n;
  return {
    examId,
    moduleTitle: exam.title,
    classAverage,
    passed: classAverage >= exam.pass_threshold,
    passThreshold: exam.pass_threshold,
    openBook: exam.open_book === 1,
    concepts,
    heatmap,
    teacherErrors: errors,
    analysis: stored,
    graduated:
      (
        sqlite.prepare("SELECT status FROM classrooms WHERE id = ?").get(exam.classroom_id) as {
          status: string;
        }
      ).status === "graduated",
    xpEarned: xp,
    // V7-05: the simulated rival class on the same module.
    rival: rivalFor(handle, examId) ?? undefined,
  };
}
