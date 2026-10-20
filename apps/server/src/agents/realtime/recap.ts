import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ModelFactory } from "../../models/factory.js";
import { loadPrompt } from "../prompts/load.js";

// Recap Writer (docs/02 §2.2): "Last time…" at bell-in, "Next time…" at bell-out.

export async function writeRecap(
  factory: ModelFactory,
  input: {
    kind: "in" | "out";
    teacherLines: string[];
    weakConcepts: string[];
    nextConcept?: string;
  },
): Promise<string> {
  const transcript = input.teacherLines.length
    ? input.teacherLines
        .map((l) => `Headmaster: ${l}`)
        .join("\n")
        .slice(-6000)
    : "(nothing taught)";
  const system = loadPrompt("recapWriter", {
    isIntro: input.kind === "in",
    nextConcept: input.nextConcept ?? "the next concept",
    transcript,
    weak: input.weakConcepts.join(", "),
  });
  const res = await factory.run("recapWriter", ({ model }) =>
    model.invoke([new SystemMessage(system), new HumanMessage("Write the card.")]),
  );
  // The caller prints its own "Last time…/Next time…" heading; drop the model's.
  return String(res.content)
    .trim()
    .replace(/^\s*(#+\s*|\*\*)?\s*(last|next) time\s*(…|\.\.\.)?\s*(\*\*)?\s*:?\s*\n+/i, "")
    .trim();
}
