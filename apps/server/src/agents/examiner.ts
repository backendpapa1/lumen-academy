import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { QuestionSetZ, type QuestionDraft } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import type { ModelFactory } from "../models/factory.js";
import { callStructured } from "./harness.js";
import { loadPrompt } from "./prompts/load.js";

// Examiner (docs/03 §3.3, A-1, E-2). A lean structured call: the server gives
// it each concept's facts and cited passages plus the class's weak spots, so
// it needs no tool loop (ADR-001). Every question is validated against the
// source; invalid ones are sent back once, then dropped.

export interface ExamConcept {
  id: string;
  title: string;
  keyFacts: string[];
  misconceptions: string[];
  passages: Array<{ id: string; text: string }>;
}

export interface ExaminerInput {
  kind: "assignment" | "exam";
  count: number;
  concepts: ExamConcept[];
  /** Per concept: class comprehension and misconceptions cadets adopted. */
  weakSpots?: string;
}

export interface ExaminerResult {
  questions: QuestionDraft[];
  /** Problems found (and fixed or dropped). */
  problems: string[];
  attempts: number;
  /** First attempt, before any fix-up: how many questions were already valid. */
  firstAttempt: { total: number; valid: number };
}

const PASSAGE_CHARS = 700;

/** Concepts with their key facts and cited passages, from the database. */
export function loadExamConcepts(handle: DbHandle, conceptIds: string[]): ExamConcept[] {
  const { sqlite } = handle;
  return conceptIds.map((id) => {
    const c = sqlite
      .prepare("SELECT id, title, key_facts_json, misconceptions_json FROM concepts WHERE id = ?")
      .get(id) as
      | { id: string; title: string; key_facts_json: string; misconceptions_json: string }
      | undefined;
    if (!c) throw new Error(`no concept ${id}`);
    const passages = sqlite
      .prepare(
        "SELECT ch.id, ch.text FROM concept_citations cc JOIN chunks ch ON ch.id = cc.chunk_id WHERE cc.concept_id = ? ORDER BY ch.ord",
      )
      .all(id) as Array<{ id: string; text: string }>;
    return {
      id: c.id,
      title: c.title,
      keyFacts: JSON.parse(c.key_facts_json) as string[],
      misconceptions: JSON.parse(c.misconceptions_json) as string[],
      passages,
    };
  });
}

/** Class ledger per concept: what the Examiner should target. */
export function classWeakSpots(
  handle: DbHandle,
  classroomId: string,
  concepts: ExamConcept[],
): string {
  const lines: string[] = [];
  for (const c of concepts) {
    const rows = handle.sqlite
      .prepare(
        `SELECT l.comprehension, l.misconceptions_json FROM ledger_entries l JOIN cadets d ON d.id = l.cadet_id
         WHERE d.classroom_id = ? AND l.concept_id = ? AND d.status IN ('enrolled','transferred_in')`,
      )
      .all(classroomId, c.id) as Array<{ comprehension: number; misconceptions_json: string }>;
    const avg = rows.length ? rows.reduce((a, r) => a + r.comprehension, 0) / rows.length : 0;
    const held = new Map<string, number>();
    for (const r of rows)
      for (const m of JSON.parse(r.misconceptions_json) as Array<{ text: string }>)
        held.set(m.text, (held.get(m.text) ?? 0) + 1);
    const top = [...held].sort((a, b) => b[1] - a[1]).slice(0, 2);
    lines.push(
      `- ${c.id} ${c.title}: class understanding ${Math.round(avg * 100)}%` +
        (top.length ? `; cadets believe: ${top.map(([t, n]) => `"${t}" (${n})`).join(", ")}` : ""),
    );
  }
  return lines.join("\n");
}

function describe(concepts: ExamConcept[]): string {
  return concepts
    .map((c) =>
      [
        `### ${c.id}: ${c.title}`,
        "Key facts:",
        ...c.keyFacts.map((f) => `- ${f}`),
        ...(c.misconceptions.length
          ? ["Common misconceptions:", ...c.misconceptions.map((m) => `- ${m}`)]
          : []),
        "Passages:",
        ...c.passages.map(
          (p) => `[${p.id}] ${p.text.slice(0, PASSAGE_CHARS).replace(/\s+/g, " ")}`,
        ),
      ].join("\n"),
    )
    .join("\n\n");
}

/** Problems with one question, in words the model can act on. Empty = valid. */
export function questionProblems(
  q: QuestionDraft,
  concepts: ExamConcept[],
  kind: ExaminerInput["kind"],
): string[] {
  const c = concepts.find((x) => x.id === q.conceptId);
  if (!c) return [`conceptId "${q.conceptId}" is not one of the listed concepts`];
  const p: string[] = [];
  const allowed = new Set(c.passages.map((x) => x.id));
  const bad = q.citations.filter((id) => !allowed.has(id));
  if (bad.length) p.push(`citations ${bad.join(", ")} are not passages of ${c.id}`);
  if (q.kind === "mcq") {
    if (kind === "assignment") p.push("assignments use short or eli10 questions, not mcq");
    const opts = q.options ?? [];
    if (opts.length !== 4 || new Set(opts.map((o) => o.trim().toLowerCase())).size !== 4)
      p.push("mcq needs exactly 4 different options");
    else if (!opts.some((o) => o.trim() === q.answerKey.trim()))
      p.push("mcq answerKey must equal one option exactly");
  }
  return p;
}

export async function draftQuestions(
  factory: ModelFactory,
  input: ExaminerInput,
): Promise<ExaminerResult> {
  const usable = input.concepts.filter((c) => c.passages.length);
  if (!usable.length) throw new Error("none of these concepts has source passages to examine");
  const system = loadPrompt("examiner", {
    isExam: input.kind === "exam",
    count: input.count,
    weakSpots: input.weakSpots ?? "",
    concepts: describe(usable),
  });
  const messages = [
    new SystemMessage(system),
    new HumanMessage(`Write the ${input.count} questions.`),
  ];
  const problems: string[] = [];
  let attempts = 0;
  let valid: QuestionDraft[] = [];
  let firstAttempt = { total: 0, valid: 0 };
  for (let round = 0; round < 2; round++) {
    attempts++;
    const set = (
      await callStructured(factory, "examiner", {
        schema: QuestionSetZ,
        name: "question_set",
        messages,
      })
    ).data;
    const issues: string[] = [];
    valid = [];
    set.questions.forEach((q, i) => {
      const p = questionProblems(q, usable, input.kind);
      if (p.length) issues.push(`Question ${i + 1}: ${p.join("; ")}`);
      else valid.push(q);
    });
    problems.push(...issues);
    if (round === 0) firstAttempt = { total: set.questions.length, valid: valid.length };
    if (!issues.length || round === 1) break;
    messages.push(
      new HumanMessage(
        `Some questions are invalid:\n${issues.join("\n")}\nReturn the full set of ${input.count} questions again, with these fixed.`,
      ),
    );
  }
  const min = input.kind === "exam" ? Math.min(5, input.count) : Math.min(3, input.count);
  if (valid.length < min)
    throw new Error(`the Examiner produced only ${valid.length} valid questions`);
  return { questions: valid.slice(0, input.count), problems, attempts, firstAttempt };
}
