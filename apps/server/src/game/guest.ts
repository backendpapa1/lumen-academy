import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { GuestAnswerZ, type GameConfig } from "@lumen/shared";
import { callStructured } from "../agents/harness.js";
import { loadPrompt } from "../agents/prompts/load.js";
import type { DbHandle } from "../db/client.js";
import { newId } from "../db/ids.js";
import type { Embedder } from "../ingest/embed.js";
import type { ModelFactory } from "../models/factory.js";
import { hybridSearch } from "../retrieval/search.js";

// Guest lecturer (V5-09): a made-up expert answers from MY sources only, with
// citations, as a model of a good explanation for me. Capped per week (it
// costs a little). Saved with speaker 'guest', so it never enters a
// student's pack, notes or recall: knowledge gating is unchanged.

/** Invented names only, never a real person. */
const GUESTS = [
  "Dr Juniper Vale",
  "Professor Otto Lumenfeld",
  "Dr Marisol Quillon",
  "Professor Bram Sunderby",
];

export function guestsLeft(handle: DbHandle, game: GameConfig, now = new Date()): number {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const used = (
    handle.sqlite
      .prepare("SELECT count(*) n FROM messages WHERE speaker = 'guest' AND created_at >= ?")
      .get(since) as { n: number }
  ).n;
  return Math.max(0, game.modes.guestPerWeek - used);
}

export interface GuestAnswer {
  name: string;
  question: string;
  answer: string;
  citations: Array<{ source: string; heading: string; page: number | null }>;
}

export async function askGuest(
  deps: { handle: DbHandle; factory: ModelFactory; embedder: Embedder },
  input: { schoolId: string; schoolName: string; periodId: string; question: string },
): Promise<GuestAnswer> {
  const hits = await hybridSearch(deps, { schoolId: input.schoolId, query: input.question, k: 5 });
  if (!hits.length) throw new Error("Your sources don't have anything on that yet.");
  const name = GUESTS[input.periodId.length % GUESTS.length]!;
  const res = await callStructured(deps.factory, "guestLecturer", {
    schema: GuestAnswerZ,
    name: "guest_answer",
    messages: [
      new SystemMessage(
        loadPrompt("guestLecturer", {
          name,
          schoolName: input.schoolName,
          passages: hits.map((h) => `[${h.chunkId}] ${h.text}`).join("\n\n"),
        }),
      ),
      new HumanMessage(`The class's question: "${input.question}"`),
    ],
  });
  // Only citations to passages it was actually given count.
  const ids = new Set(hits.map((h) => h.chunkId));
  const cited = res.data.citations.filter((c) => ids.has(c));
  const rows = cited.length
    ? (deps.handle.sqlite
        .prepare(
          `SELECT c.id, c.heading_path h, c.page_from p, s.title t FROM chunks c JOIN sources s ON s.id = c.source_id
           WHERE c.id IN (${cited.map(() => "?").join(",")})`,
        )
        .all(...cited) as Array<{ id: string; h: string | null; p: number | null; t: string }>)
    : [];
  deps.handle.sqlite
    .prepare(
      "INSERT INTO messages (id, period_id, speaker, kind, text, meta_json, created_at) VALUES (?, ?, 'guest', 'event', ?, ?, ?)",
    )
    .run(
      newId("message"),
      input.periodId,
      res.data.answer,
      JSON.stringify({ guest: name, question: input.question, citations: cited }),
      new Date().toISOString(),
    );
  return {
    name,
    question: input.question,
    answer: res.data.answer,
    // One line per distinct reference, even when several chunks share a heading.
    citations: [
      ...new Map(
        rows.map((r) => [
          `${r.t}|${r.h ?? ""}|${r.p ?? ""}`,
          { source: r.t, heading: r.h ?? "", page: r.p },
        ]),
      ).values(),
    ],
  };
}
