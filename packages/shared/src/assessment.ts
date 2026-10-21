import { z } from "zod";

// Assessment (docs/03 §3.3–3.4, PRD A-1..A-5, E-1..E-5): what the Examiner
// writes, what cadets submit, what the Grader and the Debrief return.

export const QUESTION_KINDS = ["mcq", "short", "eli10"] as const;
export const QuestionKindZ = z.enum(QUESTION_KINDS);
export type QuestionKind = z.infer<typeof QuestionKindZ>;

/** One Examiner question. Validated against the source by the server. */
export const QuestionDraftZ = z.object({
  kind: QuestionKindZ,
  conceptId: z.string().min(1),
  prompt: z.string().min(8),
  /** mcq only: exactly 4 options, one of them equal to answerKey. */
  options: z.array(z.string().min(1)).optional(),
  answerKey: z.string().min(1),
  /** What a full-credit answer must contain, as short bullet facts. */
  rubric: z.array(z.string().min(3)).min(1).max(6),
  citations: z.array(z.string().min(1)).min(1),
});
export type QuestionDraft = z.infer<typeof QuestionDraftZ>;

export const QuestionSetZ = z.object({ questions: z.array(QuestionDraftZ).min(1).max(14) });
export type QuestionSet = z.infer<typeof QuestionSetZ>;

export interface QuestionView extends QuestionDraft {
  id: string;
  ord: number;
  conceptTitle: string;
}

export interface AnswerView {
  questionId: string;
  answer: string;
  confidence: number;
  /** Grader reference, 0..5. */
  refScore: number | null;
  refRationale: string;
}

export interface SubmissionView {
  id: string;
  cadetId: string;
  cadetName: string;
  archetype: string;
  portraitUrl: string | null;
  answers: AnswerView[];
  /** Grader reference on the 1–5 scale I grade on. */
  refScore: number | null;
  myScore: number | null;
  myComment: string | null;
  gradedAt: string | null;
  /** The cadet's reaction when the work came back. */
  reaction: string | null;
}

export interface AssignmentView {
  id: string;
  classroomId: string;
  title: string;
  status: "draft" | "issued" | "submitted" | "graded";
  questions: QuestionView[];
  submissions: SubmissionView[];
  createdAt: string;
}

export const DebriefContentZ = z.object({
  /** 2–4 short lines. */
  strengths: z.array(z.string()).max(4),
  gaps: z.array(z.string()).max(4),
  /** Ordered re-teach steps, each tied to a concept. */
  plan: z.array(z.object({ conceptId: z.string(), step: z.string() })).max(5),
});
export type DebriefContent = z.infer<typeof DebriefContentZ>;

export interface ConceptResult {
  conceptId: string;
  title: string;
  /** Class mean on this concept's exam questions, 0..1. */
  score: number;
  /** Mean teaching turns per cadet (ledger exposures). */
  turns: number;
  underTaught: boolean;
  /** Where in the source to look (heading path / page). */
  references: Array<{ chunkId: string; where: string; excerpt: string }>;
}

export interface DebriefView {
  examId: string;
  moduleTitle: string;
  classAverage: number;
  passed: boolean;
  passThreshold: number;
  concepts: ConceptResult[];
  /** score per cadet per concept, 0..1 */
  heatmap: Array<{ cadetId: string; name: string; scores: Record<string, number> }>;
  teacherErrors: Array<{
    claim: string;
    correction: string;
    conceptTitle: string | null;
    citation: string | null;
  }>;
  analysis: DebriefContent | null;
  xpEarned: number;
}
