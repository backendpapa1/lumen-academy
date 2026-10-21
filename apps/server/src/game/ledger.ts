import { and, eq, inArray } from "drizzle-orm";
import type { GameConfig, LearningStyle, TeachingAnalysis } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { ledgerEntries } from "../db/schema.js";
import { adoptsMisconception, applyDelta, comprehensionDelta } from "./comprehension.js";
import { reinforce } from "./memory.js";

// Applies one teaching turn to every cadet's Knowledge Ledger (T-5). The
// Director proposes; this computes the final numbers (docs/03 §4.3).

export interface LedgerCadet {
  id: string;
  attention: number;
  skepticism: number;
  learningStyle: LearningStyle;
}

export interface Misconception {
  text: string;
  source: "teacher_error" | "archetype" | "spread";
  since: string;
}

export interface TurnInput {
  turnId: string;
  message: string;
  periodMinute: number;
  analysis: TeachingAnalysis; // already normalised
  cadets: LedgerCadet[];
  lowConfidence?: boolean;
  now?: string;
}

export interface LedgerChange {
  cadetId: string;
  conceptId: string;
  comprehension: number;
  delta: number;
  adopted: string[];
  resolved: string[];
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
/** A correction "resolves" a held misconception if one text contains the other (after normalising). */
const sameIdea = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
};

export function applyTurnToLedger(
  handle: DbHandle,
  cfg: Pick<GameConfig, "comprehension" | "fatigue"> & Partial<Pick<GameConfig, "memory">>,
  t: TurnInput,
): LedgerChange[] {
  const { db, sqlite } = handle;
  const concepts = t.analysis.conceptIds;
  if (!concepts.length || !t.cadets.length) return [];
  const now = t.now ?? new Date().toISOString();
  const quality = { accuracy: t.analysis.teaching.accuracy, clarity: t.analysis.teaching.clarity };
  const claims = t.analysis.teaching.errors.map((e) => e.claim);

  return sqlite.transaction(() => {
    const existing = db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          inArray(
            ledgerEntries.cadetId,
            t.cadets.map((c) => c.id),
          ),
          inArray(ledgerEntries.conceptId, concepts),
        ),
      )
      .all();
    const key = (cadetId: string, conceptId: string) => `${cadetId}|${conceptId}`;
    const byKey = new Map(existing.map((e) => [key(e.cadetId, e.conceptId), e]));
    const changes: LedgerChange[] = [];

    for (const cadet of t.cadets) {
      for (const conceptId of concepts) {
        const row = byKey.get(key(cadet.id, conceptId));
        const proposal = t.analysis.ledgerDeltas.find(
          (d) => d.cadetId === cadet.id && d.conceptId === conceptId,
        );
        const d = comprehensionDelta(
          {
            teaching: quality,
            cadet,
            message: t.message,
            periodMinute: t.periodMinute,
            proposedDelta: proposal?.comprehensionDelta,
            lowConfidence: t.lowConfidence,
          },
          cfg,
        );
        let held: Misconception[] = row
          ? (JSON.parse(row.misconceptionsJson) as Misconception[])
          : [];

        // Corrections first, so a fixed error isn't immediately re-adopted.
        const resolved: string[] = [];
        if (proposal?.resolvedMisconception) {
          const fix = proposal.resolvedMisconception;
          const before = held.length;
          held = held.filter((m) => !sameIdea(m.text, fix));
          if (held.length < before) resolved.push(fix);
        }
        // Teacher errors (and the Director's per-cadet phrasing of them) spread by skepticism roll.
        const adopted: string[] = [];
        const candidates = [
          ...claims,
          ...(proposal?.newMisconception ? [proposal.newMisconception] : []),
        ];
        for (const claim of candidates) {
          if (held.some((m) => sameIdea(m.text, claim))) continue;
          if (
            adoptsMisconception(cadet.skepticism, cfg, {
              turnId: t.turnId,
              cadetId: cadet.id,
              claim,
            })
          ) {
            held.push({ text: claim, source: "teacher_error", since: now });
            adopted.push(claim);
            break; // at most one new misconception per turn and concept
          }
        }

        // V2: teach on top of what's recalled now, and a spaced review lasts longer.
        const mem = cfg.memory
          ? reinforce(row, new Date(now), cfg.memory)
          : { base: row?.comprehension ?? 0, stabilityDays: row?.stabilityDays ?? null };
        const comprehension = applyDelta(mem.base, d.delta);
        const values = {
          comprehension,
          exposures: (row?.exposures ?? 0) + 1,
          misconceptionsJson: JSON.stringify(held),
          lastTaughtAt: now,
          stabilityDays: mem.stabilityDays,
        };
        if (row) {
          db.update(ledgerEntries)
            .set(values)
            .where(and(eq(ledgerEntries.cadetId, cadet.id), eq(ledgerEntries.conceptId, conceptId)))
            .run();
        } else {
          db.insert(ledgerEntries)
            .values({ cadetId: cadet.id, conceptId, ...values })
            .run();
        }
        changes.push({
          cadetId: cadet.id,
          conceptId,
          comprehension,
          delta: d.delta,
          adopted,
          resolved,
        });
      }
    }
    return changes;
  })();
}
