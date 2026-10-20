import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ARCHETYPE_INFO, type Archetype } from "@lumen/shared";
import { eq } from "drizzle-orm";
import { loadPrompt } from "../agents/prompts/load.js";
import type { DbHandle } from "../db/client.js";
import { cadets, ledgerEntries, messages } from "../db/schema.js";
import type { ModelFactory } from "../models/factory.js";
import { withUsageContext } from "../usage/meter.js";
import type { Misconception } from "./ledger.js";

// Post-period notes rewrite (docs/03 §4.4): each cadet's notes are rewritten
// through its persona and ledger, so they inherit its misconceptions.

const understandingWord = (c: number) =>
  c < 0.2
    ? "you followed very little"
    : c < 0.45
      ? "patchy"
      : c < 0.75
        ? "decent but incomplete"
        : "solid";

/** Runs `jobs` with at most `n` in flight (the docs' p-queue, concurrency 3). */
export async function pool<T>(
  n: number,
  jobs: Array<() => Promise<T>>,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      for (let i = next++; i < jobs.length; i = next++) {
        try {
          results[i] = { status: "fulfilled", value: await jobs[i]!() };
        } catch (reason) {
          results[i] = { status: "rejected", reason };
        }
      }
    }),
  );
  return results;
}

export async function rewriteNotes(
  deps: { handle: DbHandle; factory: ModelFactory },
  input: { periodId: string; classroomId: string; concurrency?: number },
): Promise<{ updated: number; failed: number }> {
  const { db } = deps.handle;
  const teacher = db
    .select({ text: messages.text, speaker: messages.speaker })
    .from(messages)
    .where(eq(messages.periodId, input.periodId))
    .orderBy(messages.createdAt)
    .all()
    .filter((m) => m.speaker === "teacher")
    .map((m) => `- ${m.text}`);
  if (!teacher.length) return { updated: 0, failed: 0 };
  const roster = db.select().from(cadets).where(eq(cadets.classroomId, input.classroomId)).all();
  const jobs = roster.map((c) => async () => {
    const ledger = db.select().from(ledgerEntries).where(eq(ledgerEntries.cadetId, c.id)).all();
    const avg = ledger.length ? ledger.reduce((a, l) => a + l.comprehension, 0) / ledger.length : 0;
    const beliefs = ledger.flatMap((l) =>
      (JSON.parse(l.misconceptionsJson) as Misconception[]).map((m) => m.text),
    );
    const system = loadPrompt("notesRewriter", {
      name: c.name,
      archetype: ARCHETYPE_INFO[c.archetype as Archetype].label,
      understanding: understandingWord(avg),
      misconceptions: beliefs.length ? beliefs.join("; ") : "nothing in particular",
      oldNotes: c.notesMd || "(none)",
      transcript: teacher.join("\n").slice(-6000),
    });
    const res = await withUsageContext({ periodId: input.periodId }, () =>
      deps.factory.run("notesRewriter", ({ model }) =>
        model.invoke([new SystemMessage(system), new HumanMessage("Your notes:")]),
      ),
    );
    const text = String(res.content).trim();
    // Keep the model's formatting; only hard-cap runaway notes.
    const notes = !text
      ? c.notesMd
      : text.split(/\s+/).length > 320
        ? text.split(/\s+/).slice(0, 320).join(" ")
        : text;
    db.update(cadets).set({ notesMd: notes }).where(eq(cadets.id, c.id)).run();
  });
  const results = await pool(input.concurrency ?? 3, jobs);
  return {
    updated: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
  };
}
