import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { ModelFactory } from "../../models/factory.js";
import { seedFrom } from "../../game/rng.js";
import { callStructured } from "../harness.js";
import { loadPrompt } from "../prompts/load.js";

// Leak Guard (docs/03 §6.4, P1 built in M1 per D8): sampled, forced by the term
// heuristic; one rewrite attempt that turns the leak into confusion.

export const LeakVerdictZ = z.object({
  verdict: z.enum(["pass", "leak"]),
  leakedTerms: z.array(z.string()).default([]),
  reason: z.string().default(""),
});

export type GuardAction = "skipped" | "pass" | "rewrite" | "rewrite_failed";

export interface GuardOutcome {
  action: GuardAction;
  text: string;
  flaggedTerms: string[];
  leakedTerms: string[];
  reason?: string;
  forced: boolean;
}

export interface GuardInput {
  utteranceId: string;
  utterance: string;
  taughtLines: string[];
  flaggedTerms: string[];
  forced: boolean;
  sampleRate: number;
  persona: { name: string; voiceNotes: string };
}

/** Seeded so a given utterance is always sampled the same way. */
export const sampled = (utteranceId: string, rate: number) =>
  (seedFrom(utteranceId, "leakGuard") % 10_000) / 10_000 < rate;

export async function guardUtterance(factory: ModelFactory, g: GuardInput): Promise<GuardOutcome> {
  const base = { flaggedTerms: g.flaggedTerms, forced: g.forced };
  if (!g.forced && !sampled(g.utteranceId, g.sampleRate))
    return { ...base, action: "skipped", text: g.utterance, leakedTerms: [] };

  const taught =
    g.taughtLines
      .slice(-40)
      .map((l) => `- ${l}`)
      .join("\n") || "(nothing yet)";
  const verdict = (
    await callStructured(factory, "leakGuard", {
      schema: LeakVerdictZ,
      name: "leak_verdict",
      messages: [
        new SystemMessage(
          loadPrompt("leakGuard", { taught, flagged: g.flaggedTerms.join(", ") || "(none)" }),
        ),
        new HumanMessage(`Cadet said: "${g.utterance}"`),
      ],
    })
  ).data;
  if (verdict.verdict === "pass")
    return { ...base, action: "pass", text: g.utterance, leakedTerms: [] };

  try {
    const res = await factory.run("cadetTalk", ({ model }) =>
      model.invoke([
        new SystemMessage(
          loadPrompt("leakRewrite", {
            name: g.persona.name,
            voiceNotes: g.persona.voiceNotes,
            reason: verdict.reason || "untaught facts",
            leakedTerms: verdict.leakedTerms.join(", ") || "unspecified",
            utterance: g.utterance,
          }),
        ),
        new HumanMessage("Rewrite it now."),
      ]),
    );
    const text = String(res.content)
      .trim()
      .replace(/^["“]|["”]$/g, "");
    if (!text) throw new Error("empty rewrite");
    return {
      ...base,
      action: "rewrite",
      text,
      leakedTerms: verdict.leakedTerms,
      reason: verdict.reason,
    };
  } catch {
    return {
      ...base,
      action: "rewrite_failed",
      text: g.utterance,
      leakedTerms: verdict.leakedTerms,
      reason: verdict.reason,
    };
  }
}
