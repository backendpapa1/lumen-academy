import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import {
  CrowdReactionZ,
  HAND_INTENTS,
  REACTION_STATES,
  type CadetCard,
  type CrowdReaction,
  type HandIntent,
  type ReactionState,
} from "@lumen/shared";
import type { ModelFactory } from "../../models/factory.js";
import { loadPrompt } from "../prompts/load.js";
import { cadetTable, recentTranscript, type TranscriptLine } from "./context.js";

// ADR-002 (revised by spike M1-S1): the reactor streams one line per cadet so
// the first reaction reaches the client ~TTFT + a few tokens, instead of
// waiting for a whole JSON object. Seats are 1-based indices into `cards`.

const STATE_SET = new Set<string>(REACTION_STATES);
const INTENT_SET = new Set<string>(HAND_INTENTS);
const PREVIEW_MAX = 80;

export type ReactorLine =
  | { kind: "reaction"; seat: number; state: ReactionState }
  | { kind: "hand"; seat: number; intent: HandIntent; urgency: number; preview: string };

/** Parses one output line; null for anything malformed (skipped, never re-asked). */
export function parseReactorLine(raw: string): ReactorLine | null {
  const line = raw.trim().replace(/^[-*]\s*/, "");
  const reaction = /^(\d{1,2})\s+([a-z]+)$/i.exec(line);
  if (reaction) {
    const state = reaction[2]!.toLowerCase();
    return STATE_SET.has(state)
      ? { kind: "reaction", seat: Number(reaction[1]), state: state as ReactionState }
      : null;
  }
  const hand = /^H\s+(\d{1,2})\s+([a-z_0-9]+)\s+([01](?:\.\d+)?)\s+(.+)$/i.exec(line);
  if (hand) {
    const intent = hand[2]!.toLowerCase();
    if (!INTENT_SET.has(intent)) return null;
    return {
      kind: "hand",
      seat: Number(hand[1]),
      intent: intent as HandIntent,
      urgency: Math.min(1, Math.max(0, Number(hand[3]))),
      preview: hand[4]!
        .trim()
        .replace(/^["“]|["”]$/g, "")
        .slice(0, PREVIEW_MAX),
    };
  }
  return null;
}

export interface ReactorInput {
  cards: CadetCard[];
  conceptTitle: string;
  transcript: TranscriptLine[];
  teacherMessage: string;
  maxHands: number;
  /** T-10: sharper, more frequent questions. */
  hyperfocus?: boolean;
  /** R-6: gentle classes ask kindly, ruthless ones press hard. */
  difficulty?: "gentle" | "standard" | "ruthless";
}

export interface ReactorEvents {
  /** Fires as soon as each cadet's line arrives. */
  onReaction?: (cadetId: string, state: ReactionState) => void;
}

export interface ReactorResult {
  reaction: CrowdReaction;
  /** ms from call to first parsed reaction, and to completion. */
  firstReactionMs: number | null;
  totalMs: number;
  /** Cadets the model skipped (kept their last state) and malformed lines. */
  filled: number;
  skippedLines: number;
}

export function reactorMessages(input: ReactorInput): BaseMessage[] {
  const system = loadPrompt("crowdReactor", {
    maxHands: input.maxHands,
    hyperfocus: !!input.hyperfocus,
    gentle: input.difficulty === "gentle",
    ruthless: input.difficulty === "ruthless",
    conceptTitle: input.conceptTitle,
    cadetTable: cadetTable(input.cards.map((c, i) => ({ ...c, id: String(i + 1) }))),
  });
  return [
    new SystemMessage(system),
    new HumanMessage(
      `Recent class:\n${recentTranscript(input.transcript)}\n\nThe teacher just said:\n"${input.teacherMessage}"`,
    ),
  ];
}

export async function runCrowdReactor(
  factory: ModelFactory,
  input: ReactorInput,
  events: ReactorEvents = {},
  signal?: AbortSignal,
): Promise<ReactorResult> {
  const messages = reactorMessages(input);
  return factory.run("crowdReactor", async ({ model }) => {
    const started = performance.now();
    let firstReactionMs: number | null = null;
    let buffer = "";
    let skippedLines = 0;
    const states = new Map<number, ReactionState>();
    const hands: CrowdReaction["handRaises"] = [];

    const consume = (raw: string) => {
      if (!raw.trim()) return;
      const parsed = parseReactorLine(raw);
      const card = parsed ? input.cards[parsed.seat - 1] : undefined;
      if (!parsed || !card) {
        skippedLines++;
        return;
      }
      if (parsed.kind === "reaction") {
        if (states.has(parsed.seat)) return;
        states.set(parsed.seat, parsed.state);
        firstReactionMs ??= performance.now() - started;
        events.onReaction?.(card.id, parsed.state);
      } else if (hands.length < input.maxHands && !hands.some((h) => h.cadetId === card.id)) {
        hands.push({
          cadetId: card.id,
          intent: parsed.intent,
          urgency: parsed.urgency,
          preview: parsed.preview,
        });
      }
    };

    for await (const chunk of await model.stream(messages, signal ? { signal } : {})) {
      buffer += typeof chunk.content === "string" ? chunk.content : "";
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    consume(buffer);

    // Any cadet the model skipped keeps their last state.
    let filled = 0;
    const reactions = input.cards.map((card, i) => {
      const state = states.get(i + 1);
      if (!state) filled++;
      return { cadetId: card.id, state: state ?? card.lastState };
    });
    return {
      reaction: CrowdReactionZ.parse({ reactions, handRaises: hands }),
      firstReactionMs,
      totalMs: performance.now() - started,
      filled,
      skippedLines,
    };
  });
}
