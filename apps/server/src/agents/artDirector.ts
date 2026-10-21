import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { ModelFactory } from "../models/factory.js";
import { loadPrompt } from "./prompts/load.js";

// Art Director (docs/07 §2.2): one fast call turns a school's subject into
// emblem motifs for the image prompt.

const MotifsZ = z
  .string()
  .transform((s) =>
    s
      .trim()
      .replace(/^["'`]|["'`]$/g, "")
      .split("\n")[0]!
      .trim(),
  )
  .pipe(z.string().min(3).max(300));

export async function emblemMotifs(
  factory: ModelFactory,
  school: { name: string; description?: string | null },
): Promise<string> {
  const system = loadPrompt("artDirector", {
    schoolName: school.name,
    description: school.description ?? "",
  });
  const res = await factory.run("artDirector", ({ model }) =>
    model.invoke([new SystemMessage(system), new HumanMessage("Describe the motifs.")]),
  );
  return MotifsZ.parse(String(res.content));
}
