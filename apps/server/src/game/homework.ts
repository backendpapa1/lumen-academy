import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  ARCHETYPE_INFO,
  normalizeTeachingAnalysis,
  TeachingAnalysisZ,
  type Archetype,
  type AssignmentView,
  type CadetCard,
  type GameConfig,
  type QuestionDraft,
  type QuestionView,
  type SubmissionView,
} from "@lumen/shared";
import { answerQuestion, gradeAnswer } from "../agents/assessment.js";
import { classWeakSpots, draftQuestions, loadExamConcepts } from "../agents/examiner.js";
import { callStructured } from "../agents/harness.js";
import { loadPrompt } from "../agents/prompts/load.js";
import { cadetTable, keyFactList } from "../agents/realtime/context.js";
import type { DbHandle } from "../db/client.js";
import { newId } from "../db/ids.js";
import type { EventBus } from "../events.js";
import type { ModelFactory } from "../models/factory.js";
import { withUsageContext } from "../usage/meter.js";
import { applyTurnToLedger, type LedgerCadet, type Misconception } from "./ledger.js";
import { cadetPack } from "./packs.js";
import { pool } from "./pool.js";
import { awardXp } from "./xp.js";

// Assignments (A-1..A-5): the Examiner drafts questions (or the Headmaster
// writes one), every cadet answers from its own knowledge pack (ADR-003), the
// Grader gives a reference grade, the Headmaster grades, and that feedback is
// a one-to-one teaching moment that moves the cadet's ledger.

export interface HomeworkDeps {
  handle: DbHandle;
  factory: ModelFactory;
  game: GameConfig;
  bus?: EventBus;
}

interface StoredAnswer {
  questionId: string;
  answer: string;
  confidence: number;
  refScore: number | null;
  refRationale: string;
}
interface StoredSubmission {
  answers: StoredAnswer[];
  reaction: string | null;
}

const CONCURRENCY = 4;

export function assignmentQuestionCount(concepts: number): number {
  return Math.min(5, Math.max(3, concepts * 2));
}

/** Concepts this class has been taught (any ledger exposure), in curriculum order. */
export function taughtConceptIds(handle: DbHandle, classroomId: string): string[] {
  return (
    handle.sqlite
      .prepare(
        `SELECT c.id FROM concepts c JOIN modules m ON m.id = c.module_id
         WHERE m.school_id = (SELECT school_id FROM classrooms WHERE id = ?)
           AND EXISTS (SELECT 1 FROM ledger_entries l JOIN cadets d ON d.id = l.cadet_id
                       WHERE l.concept_id = c.id AND d.classroom_id = ? AND l.exposures > 0)
         ORDER BY m.ord, c.ord`,
      )
      .all(classroomId, classroomId) as Array<{ id: string }>
  ).map((r) => r.id);
}

/** A-1: create and issue an assignment; cadets' work arrives in the background. */
export async function createAssignment(
  deps: HomeworkDeps,
  input: { classroomId: string; conceptIds: string[]; prompt?: string; title?: string },
): Promise<{ assignmentId: string; questions: number }> {
  const { handle } = deps;
  if (!input.conceptIds.length) throw new Error("pick at least one concept");
  const concepts = loadExamConcepts(handle, input.conceptIds);
  let drafts: QuestionDraft[];
  if (input.prompt?.trim()) {
    // The Headmaster's own question(s), one per line, graded on the first concept's facts.
    const c = concepts[0]!;
    drafts = input.prompt
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length >= 8)
      .slice(0, 5)
      .map((prompt) => ({
        kind: "short" as const,
        conceptId: c.id,
        prompt,
        answerKey: c.keyFacts.slice(0, 3).join(" "),
        rubric: c.keyFacts.slice(0, 4),
        citations: c.passages.slice(0, 2).map((p) => p.id),
      }));
    if (!drafts.length) throw new Error("write a question of at least a few words");
  } else {
    const res = await draftQuestions(deps.factory, {
      kind: "assignment",
      count: assignmentQuestionCount(concepts.length),
      concepts,
      weakSpots: classWeakSpots(handle, input.classroomId, concepts),
    });
    drafts = res.questions;
  }
  const questions: QuestionView[] = drafts.map((q, i) => ({
    ...q,
    id: newId("examQuestion"),
    ord: i + 1,
    conceptTitle: concepts.find((c) => c.id === q.conceptId)!.title,
  }));
  const assignmentId = newId("assignment");
  const title =
    input.title?.trim() ||
    (concepts.length === 1
      ? `Homework: ${concepts[0]!.title}`
      : `Homework: ${concepts
          .map((c) => c.title)
          .slice(0, 2)
          .join(" & ")}`);
  handle.sqlite
    .prepare(
      "INSERT INTO assignments (id, classroom_id, title, questions_json, status, created_at) VALUES (?, ?, ?, ?, 'issued', ?)",
    )
    .run(
      assignmentId,
      input.classroomId,
      title,
      JSON.stringify(questions),
      new Date().toISOString(),
    );
  void collectHomework(deps, assignmentId).catch((err: unknown) =>
    deps.bus?.emit({
      type: "assignment.status",
      payload: {
        assignmentId,
        classroomId: input.classroomId,
        status: "error",
        done: 0,
        total: 0,
        detail: (err as Error).message,
      },
    }),
  );
  return { assignmentId, questions: questions.length };
}

interface CadetRow {
  id: string;
  name: string;
  homeworld: string;
  archetype: Archetype;
  voice_notes: string;
  traits_json: string;
  learning_style: string;
}

function cadetsOf(handle: DbHandle, classroomId: string): CadetRow[] {
  return handle.sqlite
    .prepare(
      "SELECT id, name, homeworld, archetype, voice_notes, traits_json, learning_style FROM cadets WHERE classroom_id = ? AND status IN ('enrolled','transferred_in') ORDER BY seat",
    )
    .all(classroomId) as CadetRow[];
}

/** A-2 + A-4: every cadet answers every question from its own pack; the Grader marks each answer. */
export async function collectHomework(deps: HomeworkDeps, assignmentId: string): Promise<void> {
  const { handle } = deps;
  const a = handle.sqlite
    .prepare("SELECT classroom_id, questions_json FROM assignments WHERE id = ?")
    .get(assignmentId) as {
    classroom_id: string;
    questions_json: string;
  };
  const questions = JSON.parse(a.questions_json) as QuestionView[];
  const cadets = cadetsOf(handle, a.classroom_id);
  const concepts = loadExamConcepts(handle, [...new Set(questions.map((q) => q.conceptId))]);
  const total = cadets.length;
  let done = 0;
  const emit = (status: "collecting" | "submitted") =>
    deps.bus?.emit({
      type: "assignment.status",
      payload: { assignmentId, classroomId: a.classroom_id, status, done, total },
    });
  emit("collecting");
  await withUsageContext({}, () =>
    pool(cadets, CONCURRENCY, async (cadet) => {
      const traits = JSON.parse(cadet.traits_json) as { confidence?: number };
      const answers: StoredAnswer[] = [];
      for (const q of questions) {
        const concept = concepts.find((c) => c.id === q.conceptId)!;
        const pack = cadetPack(handle, {
          classroomId: a.classroom_id,
          cadetId: cadet.id,
          concept: { id: concept.id, title: concept.title, keyFacts: concept.keyFacts },
          purpose: `assignment:${assignmentId}`,
        });
        const asked = q.kind === "eli10" ? `Explain like I'm 10: ${q.prompt}` : q.prompt;
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
          { purpose: "homework", maxWords: q.kind === "eli10" ? 90 : 70 },
        );
        const grade = await gradeAnswer(
          deps.factory,
          q.prompt,
          [...q.rubric, q.answerKey],
          ans.answer,
        ).catch(() => null);
        answers.push({
          questionId: q.id,
          answer: ans.answer,
          confidence: ans.confidence,
          refScore: grade?.score ?? null,
          refRationale: grade?.rationale ?? "",
        });
      }
      const scored = answers.filter((x) => x.refScore !== null);
      // Reference on my 1–5 scale: mean of 0–5 answer grades, mapped 0→1, 5→5.
      const ref = scored.length
        ? 1 + (scored.reduce((s, x) => s + x.refScore!, 0) / scored.length) * 0.8
        : null;
      const stored: StoredSubmission = { answers, reaction: null };
      handle.sqlite
        .prepare(
          `INSERT INTO submissions (id, assignment_id, cadet_id, answers_json, ref_score, ref_rationale) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(assignment_id, cadet_id) DO UPDATE SET answers_json = excluded.answers_json, ref_score = excluded.ref_score`,
        )
        .run(
          newId("submission"),
          assignmentId,
          cadet.id,
          JSON.stringify(stored),
          ref === null ? null : Math.round(ref * 10) / 10,
          scored
            .map((x) => x.refRationale)
            .filter(Boolean)
            .join(" | ")
            .slice(0, 2000),
        );
      done++;
      emit("collecting");
    }),
  );
  handle.sqlite
    .prepare("UPDATE assignments SET status = 'submitted' WHERE id = ?")
    .run(assignmentId);
  emit("submitted");
}

/** A-3 + A-5: the Headmaster's grade and comment; the comment teaches this cadet. */
export async function gradeSubmission(
  deps: HomeworkDeps,
  input: { submissionId: string; score: number; comment: string },
): Promise<{ reaction: string; comprehensionDelta: number | null }> {
  const { handle } = deps;
  if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5)
    throw new Error("a grade is 1–5");
  const sub = handle.sqlite
    .prepare(
      `SELECT s.id, s.cadet_id, s.answers_json, s.ref_score, s.graded_at, a.id AS assignment_id, a.classroom_id, a.questions_json
       FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = ?`,
    )
    .get(input.submissionId) as
    | {
        id: string;
        cadet_id: string;
        answers_json: string;
        ref_score: number | null;
        graded_at: string | null;
        assignment_id: string;
        classroom_id: string;
        questions_json: string;
      }
    | undefined;
  if (!sub) throw new Error("no such submission");
  const cadet = cadetsOf(handle, sub.classroom_id).find((c) => c.id === sub.cadet_id);
  if (!cadet) throw new Error("that cadet has left the class");
  const questions = JSON.parse(sub.questions_json) as QuestionView[];
  const stored = JSON.parse(sub.answers_json) as StoredSubmission;
  const comment = input.comment.trim();

  let delta: number | null = null;
  if (comment.length >= 8)
    delta = await feedbackLearning(deps, {
      classroomId: sub.classroom_id,
      cadet,
      questions,
      stored,
      comment,
      score: input.score,
    });

  const reaction = reactionLine(cadet, input.score, sub.ref_score);
  stored.reaction = reaction;
  const firstTime = !sub.graded_at;
  handle.sqlite
    .prepare(
      "UPDATE submissions SET my_score = ?, my_comment = ?, graded_at = ?, answers_json = ? WHERE id = ?",
    )
    .run(input.score, comment || null, new Date().toISOString(), JSON.stringify(stored), sub.id);
  if (firstTime) {
    const schoolId = (
      handle.sqlite
        .prepare("SELECT school_id FROM classrooms WHERE id = ?")
        .get(sub.classroom_id) as { school_id: string }
    ).school_id;
    awardXp(
      handle,
      deps.game,
      { schoolId, classroomId: sub.classroom_id, periodId: null },
      "submissionGraded",
    );
  }
  const left = handle.sqlite
    .prepare("SELECT count(*) AS n FROM submissions WHERE assignment_id = ? AND graded_at IS NULL")
    .get(sub.assignment_id) as { n: number };
  if (!left.n)
    handle.sqlite
      .prepare("UPDATE assignments SET status = 'graded' WHERE id = ?")
      .run(sub.assignment_id);
  return { reaction, comprehensionDelta: delta };
}

/** The Director reads the comment as one-to-one teaching for this cadet (A-5). Returns the mean comprehension change. */
async function feedbackLearning(
  deps: HomeworkDeps,
  f: {
    classroomId: string;
    cadet: CadetRow;
    questions: QuestionView[];
    stored: StoredSubmission;
    comment: string;
    score: number;
  },
): Promise<number | null> {
  const { handle } = deps;
  const conceptIds = [...new Set(f.questions.map((q) => q.conceptId))];
  const primary = loadExamConcepts(handle, [conceptIds[0]!])[0]!;
  const traits = JSON.parse(f.cadet.traits_json) as { attention: number; skepticism: number };
  const ledger = handle.sqlite
    .prepare(
      "SELECT comprehension, misconceptions_json FROM ledger_entries WHERE cadet_id = ? AND concept_id = ?",
    )
    .get(f.cadet.id, primary.id) as
    { comprehension: number; misconceptions_json: string } | undefined;
  const card: CadetCard = {
    id: f.cadet.id,
    name: f.cadet.name,
    archetype: f.cadet.archetype,
    // One-to-one feedback has the cadet's full attention.
    attention: Math.max(0.85, traits.attention),
    skepticism: traits.skepticism,
    learningStyle: f.cadet.learning_style as CadetCard["learningStyle"],
    comprehension: ledger?.comprehension ?? 0,
    misconceptions: ledger
      ? (JSON.parse(ledger.misconceptions_json) as Misconception[]).slice(-2).map((m) => m.text)
      : [],
    lastState: "attentive",
    spokeTurnsAgo: null,
  };
  const others = handle.sqlite
    .prepare(
      `SELECT c.id, c.title FROM concepts c JOIN modules m ON m.id = c.module_id
       WHERE m.school_id = (SELECT school_id FROM classrooms WHERE id = ?) AND c.id != ?`,
    )
    .all(f.classroomId, primary.id) as Array<{ id: string; title: string }>;
  const system = loadPrompt("classDirector", {
    conceptId: primary.id,
    conceptTitle: primary.title,
    keyFacts: keyFactList(primary.keyFacts),
    knownMisconceptions: primary.misconceptions.length
      ? primary.misconceptions.map((m) => `- ${m}`).join("\n")
      : "(none listed)",
    otherConcepts: others.map((x) => `- ${x.id}: ${x.title}`).join("\n"),
    cadetTable: cadetTable([card], { withSpoke: false }),
  });
  const work = f.questions
    .map(
      (q) =>
        `Q: ${q.prompt}\n${f.cadet.name}'s answer: ${f.stored.answers.find((a) => a.questionId === q.id)?.answer ?? "(none)"}`,
    )
    .join("\n\n");
  let analysis;
  try {
    analysis = (
      await callStructured(deps.factory, "classDirector", {
        schema: TeachingAnalysisZ,
        name: "teaching_analysis",
        messages: [
          new SystemMessage(system),
          new HumanMessage(
            `This is written homework feedback, one to one, to ${f.cadet.name} (${f.cadet.id}) only.\n\n${work}\n\nThe Headmaster graded it ${f.score}/5 and wrote back:\n"${f.comment}"`,
          ),
        ],
      })
    ).data;
  } catch {
    return null; // feedback still counts as graded; the ledger just doesn't move
  }
  analysis = normalizeTeachingAnalysis(analysis);
  analysis.conceptIds = analysis.conceptIds.filter((id) => conceptIds.includes(id));
  if (!analysis.conceptIds.length) analysis.conceptIds = [primary.id];
  analysis.ledgerDeltas = analysis.ledgerDeltas.filter(
    (d) => d.cadetId === f.cadet.id && analysis.conceptIds.includes(d.conceptId),
  );
  const lc: LedgerCadet = {
    id: f.cadet.id,
    attention: card.attention,
    skepticism: card.skepticism,
    learningStyle: card.learningStyle,
  };
  const changes = applyTurnToLedger(handle, deps.game, {
    turnId: `feedback:${f.cadet.id}:${Date.now()}`,
    message: f.comment,
    periodMinute: 0,
    analysis,
    cadets: [lc],
  });
  return changes.length ? changes.reduce((s, c) => s + c.delta, 0) / changes.length : 0;
}

/** How the cadet takes the grade back: plain, in character, no LLM call. */
export function reactionLine(
  c: { name: string; archetype: Archetype },
  score: number,
  ref: number | null,
): string {
  const first = c.name.split(" ")[0];
  const harsh = ref !== null && score < ref - 1;
  const generous = ref !== null && score > ref + 1;
  const lines: Record<string, [string, string, string]> = {
    skeptic: [
      "Fair. I'll want to see where I went wrong.",
      "Hm. Show me the part you marked down.",
      "I'll take it. I'd still argue question two.",
    ],
    lost_signal: [
      "Oh no, I really thought I had that one.",
      "Okay… I think I mixed two ideas up again.",
      "Wait, really? That's the best I've done!",
    ],
    overachiever: [
      "That stings. I'll redo it tonight.",
      "Solid, but not my best. Noted.",
      "Yes! Can I try the next module's set?",
    ],
    literalist: [
      "Understood. Which statements were inaccurate?",
      "Noted. I'll check my wording.",
      "Thank you. Precise feedback helps.",
    ],
    pragmatist: [
      "Okay, tell me what to fix and I'll fix it.",
      "Good enough to build on.",
      "Great, that's useful.",
    ],
    connector: [
      "Ah, so the pieces didn't connect yet.",
      "I see the link I missed now.",
      "I love how it all fits together!",
    ],
    quiet: ["…I'll read it again.", "Okay. Thank you.", "*small smile*"],
    saboteur: [
      "Bold of you. I'll get you next time.",
      "Hmm, interesting choice.",
      "Ha, I knew it.",
    ],
  };
  const set = lines[c.archetype] ?? lines.pragmatist!;
  const line = score <= 2 ? set[0] : score >= 4 ? set[2] : set[1];
  const tail = harsh ? " That felt a bit harsh." : generous ? " Was it really that good?" : "";
  return `${first}: ${line}${tail}`;
}

/** Everything the Assignment Desk shows. */
export function assignmentView(handle: DbHandle, assignmentId: string): AssignmentView | null {
  const a = handle.sqlite
    .prepare(
      "SELECT id, classroom_id AS classroomId, title, status, questions_json, created_at AS createdAt FROM assignments WHERE id = ?",
    )
    .get(assignmentId) as
    | {
        id: string;
        classroomId: string;
        title: string;
        status: AssignmentView["status"];
        questions_json: string;
        createdAt: string;
      }
    | undefined;
  if (!a) return null;
  const subs = handle.sqlite
    .prepare(
      `SELECT s.id, s.cadet_id AS cadetId, d.name AS cadetName, d.archetype, d.portrait_asset_id AS portrait,
         (SELECT status FROM assets x WHERE x.id = d.portrait_asset_id) AS portraitStatus,
         s.answers_json, s.ref_score AS refScore, s.my_score AS myScore, s.my_comment AS myComment, s.graded_at AS gradedAt
       FROM submissions s JOIN cadets d ON d.id = s.cadet_id WHERE s.assignment_id = ? ORDER BY d.seat`,
    )
    .all(assignmentId) as Array<
    Omit<SubmissionView, "answers" | "reaction" | "portraitUrl"> & {
      answers_json: string;
      portrait: string | null;
      portraitStatus: string | null;
    }
  >;
  return {
    id: a.id,
    classroomId: a.classroomId,
    title: a.title,
    status: a.status,
    createdAt: a.createdAt,
    questions: JSON.parse(a.questions_json) as QuestionView[],
    submissions: subs.map(({ answers_json, portrait, portraitStatus, ...s }) => {
      const stored = JSON.parse(answers_json) as StoredSubmission;
      return {
        ...s,
        archetype: s.archetype,
        portraitUrl: portrait && portraitStatus === "ready" ? `/api/assets/${portrait}` : null,
        answers: stored.answers,
        reaction: stored.reaction,
      };
    }),
  };
}

export const archetypeLabel = (a: string) => ARCHETYPE_INFO[a as Archetype]?.label ?? a;
