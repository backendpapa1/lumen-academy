import {
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import {
  ARCHETYPE_INFO,
  CadetUtteranceZ,
  MOODS,
  UTTERANCE_KINDS,
  type CadetUtterance,
} from "@lumen/shared";
import { z } from "zod";
import type { DbHandle } from "../../db/client.js";
import type { Embedder } from "../../ingest/embed.js";
import type { ModelFactory } from "../../models/factory.js";
import { loadPrompt } from "../prompts/load.js";
import { recentTranscript, type TranscriptLine } from "./context.js";

// Cadet talk (docs/03 §4.4, ADR-001 follow-ups): notes and ledger are in the
// prompt so most turns are a single streamed call; only recall_lesson (and the
// Overachiever's peek_ahead) are tools. Cadets never get general source search.

export const META_MARKER = "###";
const MAX_TOOL_ROUNDS = 2;

export interface CadetPersona {
  id: string;
  name: string;
  homeworld: string;
  archetype: keyof typeof ARCHETYPE_INFO;
  quirk: string;
  voiceNotes: string;
  notesMd: string;
  /** V4-04: everyday interests ("football, baking"). */
  interests?: string[];
  /** V4-03: where they are in their growth arc. */
  arcLine?: string;
}

export interface CadetTurnInput {
  /** T-10: a Hyperfocus class asks sharper questions. */
  hyperfocus?: boolean;
  /** R-6: gentle classes ask kindly, ruthless ones press hard. */
  difficulty?: "gentle" | "standard" | "ruthless";
  persona: CadetPersona;
  classroomId: string;
  concept: { id: string; title: string; nextId?: string };
  comprehension: number;
  misconceptions: string[];
  transcript: TranscriptLine[];
  intent: string;
  preview: string;
  canPeek: boolean;
  maxWords: number;
  /** V5-11: one side of a class debate. */
  debate?: { stance: "for" | "against"; claim: string; heard?: string };
  /** V5-02: the teacher's question to the student in the Socratic hot seat. */
  answering?: string;
  /** V4-05: my related claims from earlier classes (my words, so gating holds). */
  pastClaims?: string[];
  /** V4-01: talking to a classmate instead of the teacher (never with peek_ahead). */
  peer?: { role: "explain" | "reply"; name: string; said?: string };
}

export interface CadetTurnDeps {
  factory: ModelFactory;
  handle: DbHandle;
  embedder?: Embedder;
}

export interface CadetTurnResult {
  utterance: CadetUtterance;
  usedTools: string[];
  peeked: boolean;
  firstTokenMs: number | null;
  totalMs: number;
}

const comprehensionWord = (c: number) =>
  c < 0.2 ? "you're lost" : c < 0.45 ? "shaky" : c < 0.75 ? "getting there" : "you understand it";

/** Splits a streamed answer into the spoken text and the trailing meta block. */
export function parseCadetOutput(raw: string, conceptId: string): CadetUtterance {
  const i = raw.indexOf(META_MARKER);
  const text = (i >= 0 ? raw.slice(0, i) : raw).trim().replace(/^["“]|["”]$/g, "");
  const meta = i >= 0 ? raw.slice(i + META_MARKER.length) : "";
  const field = (k: string) =>
    new RegExp(`${k}\\s*:\\s*([\\w.]+)`, "i").exec(meta)?.[1]?.toLowerCase();
  const kind = field("kind");
  const mood = field("mood");
  const confidence = Number(field("confidence"));
  return CadetUtteranceZ.parse({
    text: text.slice(0, 600) || "…",
    kind: (UTTERANCE_KINDS as readonly string[]).includes(kind ?? "") ? kind : "question",
    mood: (MOODS as readonly string[]).includes(mood ?? "") ? mood : "curious",
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    conceptId,
  });
}

function cadetTools(deps: CadetTurnDeps, input: CadetTurnInput, state: { peeked: boolean }) {
  const recall = tool(
    async ({ query }) => {
      // Only what the Headmaster said in this classroom, never the source.
      const { sqlite } = deps.handle;
      let rows: { text: string }[] = [];
      if (deps.embedder) {
        const [v] = await deps.embedder.embed([query]);
        const hits = sqlite
          .prepare(
            "SELECT message_id FROM message_vec WHERE embedding MATCH ? AND k = 50 ORDER BY distance",
          )
          .all(v!) as { message_id: string }[];
        if (hits.length) {
          const ids = hits.map((x) => x.message_id);
          const found = sqlite
            .prepare(
              `SELECT m.id, m.text FROM messages m JOIN periods p ON p.id = m.period_id
               WHERE p.classroom_id = ? AND m.speaker = 'teacher' AND m.id IN (${ids.map(() => "?").join(",")})`,
            )
            .all(input.classroomId, ...ids) as { id: string; text: string }[];
          rows = ids
            .map((id) => found.find((f) => f.id === id))
            .filter((x): x is { id: string; text: string } => !!x)
            .slice(0, 5);
        }
      }
      if (!rows.length) {
        rows = sqlite
          .prepare(
            `SELECT m.text FROM messages m JOIN periods p ON p.id = m.period_id
             WHERE p.classroom_id = ? AND m.speaker = 'teacher' ORDER BY m.created_at DESC LIMIT 5`,
          )
          .all(input.classroomId) as { text: string }[];
      }
      return rows.length
        ? rows.map((r) => `Teacher: ${r.text}`).join("\n")
        : "The Headmaster hasn't said anything about that yet.";
    },
    {
      name: "recall_lesson",
      description: "Look up what the Headmaster said earlier in this class (top 5 matches).",
      schema: z.object({ query: z.string() }),
    },
  );

  const peek = tool(
    async ({ query }) => {
      if (state.peeked) return "You've already read ahead once this class.";
      state.peeked = true;
      const conceptIds = [input.concept.id, input.concept.nextId].filter((x): x is string => !!x);
      const { sqlite } = deps.handle;
      const chunks = sqlite
        .prepare(
          `SELECT DISTINCT c.id, c.text FROM chunks c JOIN concept_citations cc ON cc.chunk_id = c.id
           WHERE cc.concept_id IN (${conceptIds.map(() => "?").join(",")})`,
        )
        .all(...conceptIds) as { id: string; text: string }[];
      if (!chunks.length) return "Nothing to read ahead.";
      let ranked = chunks;
      if (deps.embedder) {
        const [v] = await deps.embedder.embed([query]);
        const dist = new Map(
          (
            sqlite
              .prepare(
                `SELECT chunk_id, vec_distance_cosine(embedding, ?) AS d FROM chunk_vec WHERE chunk_id IN (${chunks.map(() => "?").join(",")})`,
              )
              .all(v!, ...chunks.map((c) => c.id)) as { chunk_id: string; d: number }[]
          ).map((r) => [r.chunk_id, r.d]),
        );
        ranked = [...chunks].sort((a, b) => (dist.get(a.id) ?? 1) - (dist.get(b.id) ?? 1));
      }
      // Max 2 results, trimmed: a glimpse, not a textbook.
      return ranked
        .slice(0, 2)
        .map((c) => c.text.slice(0, 600))
        .join("\n\n---\n\n");
    },
    {
      name: "peek_ahead",
      description:
        "Read ahead in the source on the current or next concept. Once per class, 2 short passages.",
      schema: z.object({ query: z.string() }),
    },
  );
  return input.canPeek ? [recall, peek] : [recall];
}

export async function runCadetTurn(
  deps: CadetTurnDeps,
  input: CadetTurnInput,
  opts: { signal?: AbortSignal; onDelta?: (text: string) => void; peekedAlready?: boolean } = {},
): Promise<CadetTurnResult> {
  const p = input.persona;
  const info = ARCHETYPE_INFO[p.archetype];
  const state = { peeked: !!opts.peekedAlready };
  const tools = cadetTools(
    deps,
    { ...input, canPeek: input.canPeek && !state.peeked && !input.peer },
    state,
  );
  const system = loadPrompt("cadet", {
    name: p.name,
    homeworld: p.homeworld,
    archetypeLabel: info.label,
    archetypeBrief: info.brief,
    quirk: p.quirk,
    voiceNotes: p.voiceNotes,
    interests: p.interests?.join(", ") ?? "",
    arcLine: p.arcLine ?? "",
    conceptTitle: input.concept.title,
    intent: input.intent,
    preview: input.preview,
    comprehension: input.comprehension.toFixed(2),
    comprehensionWord: comprehensionWord(input.comprehension),
    hyperfocus: !!input.hyperfocus,
    gentle: input.difficulty === "gentle",
    ruthless: input.difficulty === "ruthless",
    misconceptions: input.misconceptions.length
      ? input.misconceptions.join("; ")
      : "nothing in particular",
    notes: p.notesMd.trim() || "(no notes yet)",
    canPeek: input.canPeek && !state.peeked && !input.peer,
    maxWords: input.maxWords,
    pastClaims: input.pastClaims?.length ? input.pastClaims.map((c) => `  - ${c}`).join("\n") : "",
    answering: input.answering ?? "",
    debateStance: input.debate ? (input.debate.stance === "for" ? "FOR" : "AGAINST") : "",
    debateClaim: input.debate?.claim ?? "",
    debateHeard: input.debate?.heard ?? "",
    peerExplain: input.peer?.role === "explain",
    peerReply: input.peer?.role === "reply",
    peerName: input.peer?.name.split(" ")[0] ?? "",
    peerSaid: input.peer?.said ?? "",
  });
  const first = p.name.split(" ")[0];
  const cue = input.debate
    ? `Teacher: ${first}, you argue ${input.debate.stance === "for" ? "for" : "against"} it.`
    : input.answering
      ? `Teacher (to you): "${input.answering}"`
      : !input.peer
        ? `Teacher: Yes, ${first}?`
        : input.peer.role === "explain"
          ? `(${first} turns to ${input.peer.name.split(" ")[0]}.)`
          : `${input.peer.name.split(" ")[0]} (to you): "${input.peer.said ?? ""}"`;
  const messages: BaseMessage[] = [
    new SystemMessage(system),
    new HumanMessage(`Class so far:\n${recentTranscript(input.transcript, 8)}\n\n${cue}`),
  ];

  return deps.factory.run("cadetTalk", async ({ model }) => {
    if (!model.bindTools) throw new Error("model can't bind tools");
    const bound = model.bindTools(tools);
    const started = performance.now();
    let firstTokenMs: number | null = null;
    const usedTools: string[] = [];
    let spoken = "";
    let streamedUpTo = 0;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let full: AIMessageChunk | undefined;
      for await (const chunk of await bound.stream(
        messages,
        opts.signal ? { signal: opts.signal } : {},
      )) {
        full = full ? full.concat(chunk) : chunk;
        if (typeof chunk.content === "string" && chunk.content) {
          spoken += chunk.content;
          firstTokenMs ??= performance.now() - started;
          // Stream only the words, never the meta block after "###".
          const visibleEnd = spoken.includes(META_MARKER)
            ? spoken.indexOf(META_MARKER)
            : Math.max(streamedUpTo, spoken.length - META_MARKER.length);
          if (visibleEnd > streamedUpTo) {
            opts.onDelta?.(spoken.slice(streamedUpTo, visibleEnd));
            streamedUpTo = visibleEnd;
          }
        }
      }
      const calls = full?.tool_calls ?? [];
      if (!calls.length || round === MAX_TOOL_ROUNDS) break;
      messages.push(full!);
      for (const call of calls) {
        const t = tools.find((x) => x.name === call.name);
        usedTools.push(call.name);
        const out = t
          ? String(await (t as { invoke: (a: unknown) => Promise<unknown> }).invoke(call.args))
          : `Unknown tool ${call.name}`;
        messages.push(new ToolMessage({ tool_call_id: call.id ?? call.name, content: out }));
      }
      spoken = "";
      streamedUpTo = 0;
    }
    // Flush the held-back end of the raw text; the client swaps in the clean
    // utterance.text on completion (cadet.done), so raw quotes don't matter.
    const visible = spoken.includes(META_MARKER)
      ? spoken.slice(0, spoken.indexOf(META_MARKER))
      : spoken;
    if (visible.length > streamedUpTo) opts.onDelta?.(visible.slice(streamedUpTo));
    const utterance = parseCadetOutput(spoken, input.concept.id);
    return {
      utterance,
      usedTools,
      peeked: state.peeked,
      firstTokenMs,
      totalMs: performance.now() - started,
    };
  });
}
