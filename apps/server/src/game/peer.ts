import type { GameConfig, PeerVerdict } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import type { Misconception } from "./ledger.js";

// Peer talk teaches too (V4-02, VD9). The server applies it, never the LLM:
// a correct explanation nudges the listener a little (less than a teacher's
// turn), a wrong one can spread its mistaken idea, as a power flicker does.
// Peer talk never adds a fact: the grader only compares with the key facts.

export interface PeerEffect {
  listenerId: string;
  conceptId: string;
  comprehension: number;
  spread?: string;
}

export function applyPeerVerdict(
  handle: DbHandle,
  game: GameConfig,
  input: { listenerId: string; conceptId: string; verdict: PeerVerdict },
): PeerEffect | null {
  const { sqlite } = handle;
  const { listenerId, conceptId, verdict } = input;
  if (verdict.verdict === "neither") return null;
  const row = sqlite
    .prepare(
      "SELECT comprehension, misconceptions_json FROM ledger_entries WHERE cadet_id = ? AND concept_id = ?",
    )
    .get(listenerId, conceptId) as
    { comprehension: number; misconceptions_json: string } | undefined;
  const c = row?.comprehension ?? 0;
  const held = row ? (JSON.parse(row.misconceptions_json) as Misconception[]) : [];
  let next = c;
  let spread: string | undefined;
  if (verdict.verdict === "correct") next = Math.min(1, c + game.peerTalk.correctGain);
  else if (verdict.misconception && !held.some((m) => m.text === verdict.misconception)) {
    spread = verdict.misconception;
    held.push({ text: spread, source: "peer", since: new Date().toISOString() });
  } else return null;
  if (row)
    sqlite
      .prepare(
        "UPDATE ledger_entries SET comprehension = ?, misconceptions_json = ? WHERE cadet_id = ? AND concept_id = ?",
      )
      .run(next, JSON.stringify(held), listenerId, conceptId);
  else
    sqlite
      .prepare(
        "INSERT INTO ledger_entries (cadet_id, concept_id, comprehension, exposures, misconceptions_json) VALUES (?, ?, ?, 0, ?)",
      )
      .run(listenerId, conceptId, next, JSON.stringify(held));
  return { listenerId, conceptId, comprehension: next, ...(spread ? { spread } : {}) };
}
