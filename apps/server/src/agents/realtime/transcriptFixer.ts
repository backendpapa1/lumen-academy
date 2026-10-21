import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { ModelFactory } from "../../models/factory.js";
import { callStructured } from "../harness.js";
import { loadPrompt } from "../prompts/load.js";

// V1 voice: Whisper mishears accents and jargon ("ash" for hash). One short,
// budget-guarded call fixes clear mishearings with the School's glossary, so
// the Director never marks me down for the recogniser's mistake.

export const FixedTranscriptZ = z.object({ text: z.string().max(2000) });

export async function fixTranscript(
  factory: ModelFactory,
  input: {
    text: string;
    schoolName: string;
    conceptTitle: string;
    glossary: string;
    recent: string[];
  },
): Promise<string> {
  const res = await callStructured(factory, "transcriptFixer", {
    schema: FixedTranscriptZ,
    name: "fixed_transcript",
    messages: [
      new SystemMessage(
        loadPrompt("transcriptFixer", {
          schoolName: input.schoolName,
          conceptTitle: input.conceptTitle,
          glossary: input.glossary,
          recent: input.recent.map((r) => `- ${r}`).join("\n"),
        }),
      ),
      new HumanMessage(`Transcript: ${input.text}`),
    ],
  });
  // Spoken sentences often come back ending on a comma; close them.
  const fixed = res.data.text.trim().replace(/[,;]\s*$/, ".");
  // A fix that rewrites most of the line isn't a fix: keep what was heard.
  return fixed && fixed.length < input.text.length * 1.6 + 20 ? fixed : input.text;
}
