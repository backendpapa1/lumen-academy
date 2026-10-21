import type { GameConfig, TeachingAnalysis } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { newId } from "../db/ids.js";
import type { LedgerChange } from "./ledger.js";

// Stickers (V4-06): students hand them out for great moments. Awarded by
// server rules on what the Director already reports, never by the LLM: each
// kind at most once a period, a few per period in all.

export const STICKER_KINDS = {
  best_analogy: "Best analogy!",
  fixed_confusion: "Fixed my confusion",
  brave_correction: "Brave correction",
  landed: "That one landed!",
} as const;
export type StickerKind = keyof typeof STICKER_KINDS;

export interface Sticker {
  id: string;
  cadetId: string;
  kind: StickerKind;
  label: string;
}

const ANALOGY =
  /\b(it'?s like|is like|just like|like a|imagine|think of (it|this) as|picture|similar to)\b/i;
const OWN_FIX =
  /\b(i was wrong|i got (that|it) wrong|let me correct|correction:|i made a mistake|i misspoke|scratch that|i said .* earlier, but)\b/i;

export interface StickerTurn {
  periodId: string;
  classroomId: string;
  text: string;
  analysis: TeachingAnalysis;
  changes: LedgerChange[];
  students: Array<{ id: string; archetype: string; interests: string[] }>;
}

/** The stickers this turn earns (already saved), in the order they happened. */
export function awardStickers(handle: DbHandle, game: GameConfig, t: StickerTurn): Sticker[] {
  if (!game.stickers.enabled || !t.students.length) return [];
  const { sqlite } = handle;
  const given = sqlite
    .prepare("SELECT kind FROM stickers WHERE period_id = ?")
    .all(t.periodId) as Array<{ kind: string }>;
  let room = game.stickers.maxPerPeriod - given.length;
  const out: Sticker[] = [];
  const { accuracy, clarity, errors } = t.analysis.teaching;
  const sound = accuracy >= 0.7 && !errors.length;
  const gainOf = (id: string) => t.changes.find((c) => c.cadetId === id)?.delta ?? 0;
  const mostHelped = () => [...t.students].sort((a, b) => gainOf(b.id) - gainOf(a.id))[0]!.id;
  const give = (kind: StickerKind, cadetId: string) => {
    if (room <= 0 || given.some((g) => g.kind === kind) || out.some((o) => o.kind === kind)) return;
    const s: Sticker = { id: newId("sticker"), cadetId, kind, label: STICKER_KINDS[kind] };
    sqlite
      .prepare(
        "INSERT INTO stickers (id, classroom_id, period_id, cadet_id, kind, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        s.id,
        t.classroomId,
        t.periodId,
        cadetId,
        kind,
        t.text.slice(0, 200),
        new Date().toISOString(),
      );
    out.push(s);
    room--;
  };

  // A mix-up I cleared up: the student it helped says so.
  const fixed = t.changes.find((c) => c.resolved.length);
  if (fixed) give("fixed_confusion", fixed.cadetId);
  // Correcting myself, and getting it right this time.
  if (OWN_FIX.test(t.text) && sound)
    give("brave_correction", t.students.find((s) => s.archetype === "skeptic")?.id ?? mostHelped());
  // An example from a student's own world (V4-04).
  const fan = t.students.find((s) =>
    s.interests.some((i) => new RegExp(`\\b${i.replace(/[^\w ]/g, "")}`, "i").test(t.text)),
  );
  if (fan && clarity >= 0.7 && sound) give("landed", fan.id);
  // A clear, correct analogy.
  if (ANALOGY.test(t.text) && clarity >= 0.8 && sound) give("best_analogy", mostHelped());
  return out;
}

/** The classroom's latest stickers, for the corkboard. */
export function recentStickers(handle: DbHandle, classroomId: string, limit = 12): Sticker[] {
  return (
    handle.sqlite
      .prepare(
        "SELECT id, cadet_id AS cadetId, kind FROM stickers WHERE classroom_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(classroomId, limit) as Array<{ id: string; cadetId: string; kind: StickerKind }>
  ).map((s) => ({ ...s, label: STICKER_KINDS[s.kind] ?? s.kind }));
}
