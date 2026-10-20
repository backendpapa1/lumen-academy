import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ARCHETYPE_INFO, type Archetype } from "@lumen/shared";
import { z } from "zod";
import { formatPack, type KnowledgePack } from "../game/knowledgePack.js";
import type { ModelFactory } from "../models/factory.js";
import { callStructured } from "./harness.js";
import { loadPrompt } from "./prompts/load.js";

// Cadet answers from knowledge packs (ADR-003) and Grader scoring against
// source facts. Used by the eval harness now, assignments/exams in M4.

export const AnswerZ = z.object({ answer: z.string(), confidence: z.number() });
export const GradeZ = z.object({
  score: z.number(),
  present: z.array(z.string()).default([]),
  missing: z.array(z.string()).default([]),
  contradictions: z.array(z.string()).default([]),
  rationale: z.string().default(""),
});
export type Grade = z.infer<typeof GradeZ>;

export interface AnsweringCadet {
  name: string;
  homeworld: string;
  archetype: Archetype;
  voiceNotes: string;
  confidence: number;
}

const confidenceWord = (c: number) =>
  c < 0.35 ? "unsure of yourself" : c > 0.7 ? "confident" : "fairly confident";

export async function answerQuestion(
  factory: ModelFactory,
  cadet: AnsweringCadet,
  packs: KnowledgePack[],
  question: string,
  opts: { purpose: "homework" | "exam"; maxWords?: number },
): Promise<z.infer<typeof AnswerZ>> {
  const system = loadPrompt("cadetAnswer", {
    name: cadet.name,
    homeworld: cadet.homeworld,
    archetype: ARCHETYPE_INFO[cadet.archetype].label,
    voiceNotes: cadet.voiceNotes,
    purpose: opts.purpose,
    pack: formatPack(packs),
    confidenceWord: confidenceWord(cadet.confidence),
    maxWords: opts.maxWords ?? 80,
  });
  return (
    await callStructured(factory, "cadetHomework", {
      schema: AnswerZ,
      name: "answer",
      messages: [new SystemMessage(system), new HumanMessage(question)],
    })
  ).data;
}

/** Score 0–5 strictly against the given facts (prompts/grader.md), clamped. */
export async function gradeAnswer(
  factory: ModelFactory,
  question: string,
  facts: string[],
  answer: string,
): Promise<Grade> {
  const list = facts.map((f, i) => `kf${i + 1}: ${f}`).join("\n");
  const g = (
    await callStructured(factory, "grader", {
      schema: GradeZ,
      name: "grade",
      messages: [
        new SystemMessage(loadPrompt("grader", { question, facts: list })),
        new HumanMessage(`Student answer: ${answer}`),
      ],
    })
  ).data;
  return { ...g, score: Math.min(5, Math.max(0, Math.round(g.score))) };
}
