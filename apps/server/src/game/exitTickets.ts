import type { GameConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { newId } from "../db/ids.js";
import type { Misconception } from "./ledger.js";
import { cadetPack } from "./packs.js";
import { rng, seedFrom } from "./rng.js";
import { awardXp } from "./xp.js";

// Exit tickets (docs/02 §5, M4-05): at the bell each cadet states one thing
// about today's concept, true (a fact it retained) or false (a misconception it
// holds, or a common one), in the teacher's own words (ADR-003). Only after a
// class that taught something. The teacher has 60s to mark ✓/✗. Rejecting a
// false statement corrects that cadet; nothing here calls a model.

export interface ExitTicket {
  id: string;
  cadetId: string;
  statement: string;
}

export function issueExitTickets(
  handle: DbHandle,
  input: {
    periodId: string;
    classroomId: string;
    conceptId: string;
    memory?: import("@lumen/shared").GameConfig["memory"];
  },
): ExitTicket[] {
  const { sqlite } = handle;
  const concept = sqlite
    .prepare("SELECT id, title, key_facts_json, misconceptions_json FROM concepts WHERE id = ?")
    .get(input.conceptId) as
    { id: string; title: string; key_facts_json: string; misconceptions_json: string } | undefined;
  if (!concept) return [];
  // "What did you take away today?" only makes sense if today taught something:
  // at least one turn this period covered a key fact of this concept.
  const turns = sqlite
    .prepare("SELECT analysis_json FROM turns WHERE period_id = ?")
    .all(input.periodId) as Array<{ analysis_json: string }>;
  const taughtToday = turns.some((t) => {
    const a = JSON.parse(t.analysis_json) as {
      conceptIds?: string[];
      teaching?: { coverage?: string[] };
    };
    return a.conceptIds?.includes(input.conceptId) && (a.teaching?.coverage?.length ?? 0) > 0;
  });
  if (!taughtToday) return [];
  const keyFacts = JSON.parse(concept.key_facts_json) as string[];
  const common = JSON.parse(concept.misconceptions_json) as string[];
  const cadets = sqlite
    .prepare(
      "SELECT id FROM cadets WHERE classroom_id = ? AND status IN ('enrolled','transferred_in') ORDER BY seat",
    )
    .all(input.classroomId) as Array<{ id: string }>;
  const insert = sqlite.prepare(
    "INSERT INTO exit_tickets (id, period_id, cadet_id, concept_id, statement, is_true, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const out: ExitTicket[] = [];
  const now = new Date().toISOString();
  sqlite.transaction(() => {
    for (const c of cadets) {
      const r = rng(seedFrom(c.id, input.periodId, "exit"));
      const pack = cadetPack(handle, {
        classroomId: input.classroomId,
        cadetId: c.id,
        concept: { id: concept.id, title: concept.title, keyFacts },
        purpose: `exit:${input.periodId}`,
        memory: input.memory,
      });
      const held = pack.misconceptions;
      // A cadet who holds a misconception says it half the time; one who retained
      // nothing reaches for a common one; otherwise a fact it remembers.
      let statement: string | undefined;
      let isTrue = true;
      if (held.length && (r() < 0.5 || !pack.retained.length)) {
        statement = held[Math.floor(r() * held.length)];
        isTrue = false;
      } else if (pack.retained.length) {
        statement = pack.retained[Math.floor(r() * pack.retained.length)];
      } else if (common.length) {
        statement = common[Math.floor(r() * common.length)];
        isTrue = false;
      }
      if (!statement) continue;
      const id = newId("exitTicket");
      insert.run(id, input.periodId, c.id, concept.id, statement, isTrue ? 1 : 0, now);
      out.push({ id, cadetId: c.id, statement });
    }
  })();
  return out;
}

/** ✓/✗ on one ticket. Returns whether the Headmaster was right, and the truth. */
export function markExitTicket(
  handle: DbHandle,
  input: { ticketId: string; verdict: boolean },
): { right: boolean; isTrue: boolean; corrected: boolean } | null {
  const { sqlite } = handle;
  const t = sqlite
    .prepare(
      "SELECT id, cadet_id, concept_id, statement, is_true, verdict FROM exit_tickets WHERE id = ?",
    )
    .get(input.ticketId) as
    | {
        id: string;
        cadet_id: string;
        concept_id: string;
        statement: string;
        is_true: number;
        verdict: number | null;
      }
    | undefined;
  if (!t) return null;
  const isTrue = t.is_true === 1;
  const right = input.verdict === isTrue;
  sqlite
    .prepare("UPDATE exit_tickets SET verdict = ?, correct = ? WHERE id = ?")
    .run(input.verdict ? 1 : 0, right ? 1 : 0, t.id);
  let corrected = false;
  // ✗ on a misconception this cadet holds: corrected (a small learning event).
  if (!isTrue && !input.verdict && t.verdict === null) {
    const row = sqlite
      .prepare(
        "SELECT comprehension, misconceptions_json FROM ledger_entries WHERE cadet_id = ? AND concept_id = ?",
      )
      .get(t.cadet_id, t.concept_id) as
      { comprehension: number; misconceptions_json: string } | undefined;
    if (row) {
      const held = JSON.parse(row.misconceptions_json) as Misconception[];
      const kept = held.filter((m) => m.text !== t.statement);
      corrected = kept.length < held.length;
      sqlite
        .prepare(
          "UPDATE ledger_entries SET misconceptions_json = ?, comprehension = min(1, comprehension + ?) WHERE cadet_id = ? AND concept_id = ?",
        )
        .run(JSON.stringify(kept), corrected ? 0.04 : 0.01, t.cadet_id, t.concept_id);
    }
  }
  return { right, isTrue, corrected };
}

/** Once per period, when at least half the tickets were marked. */
export function finishExitTickets(
  handle: DbHandle,
  game: GameConfig,
  scope: { schoolId: string; classroomId: string; periodId: string },
): { marked: number; total: number; right: number; xp: number } {
  const { sqlite } = handle;
  const s = sqlite
    .prepare(
      "SELECT count(*) AS total, count(verdict) AS marked, coalesce(sum(correct), 0) AS right FROM exit_tickets WHERE period_id = ?",
    )
    .get(scope.periodId) as { total: number; marked: number; right: number };
  const already = sqlite
    .prepare(
      "SELECT count(*) AS n FROM xp_events WHERE period_id = ? AND kind = 'exitTicketComplete'",
    )
    .get(scope.periodId) as { n: number };
  const xp =
    !already.n && s.total && s.marked * 2 >= s.total
      ? awardXp(handle, game, scope, "exitTicketComplete")
      : 0;
  return { ...s, xp };
}
