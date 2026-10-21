import type { GameConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";

// XP (docs/02 §7.1): an append-only xp_events log; amounts come from
// game.yaml. periods.xp_earned mirrors the period's sum for the Debrief.

export type XpKind = keyof GameConfig["xp"] & string;

export interface XpStanding {
  total: number;
  rank: string;
  /** The next rank and the XP it needs, or null at the top. */
  next: { name: string; minXp: number } | null;
  /** Progress from this rank's floor to the next, 0..1. */
  progress: number;
}

export interface XpScope {
  schoolId: string;
  /** Null outside a class (the study hall). */
  classroomId: string | null;
  /** Null for XP earned outside a class period (grading, exams). */
  periodId: string | null;
}

export function awardXp(
  handle: DbHandle,
  game: GameConfig,
  scope: XpScope,
  kind: XpKind,
  units = 1,
): number {
  const per = game.xp[kind];
  if (per === undefined) throw new Error(`no XP value for ${kind} in game.yaml`);
  const amount = Math.round(per * units);
  if (amount <= 0) return 0;
  const { sqlite } = handle;
  sqlite.transaction(() => {
    sqlite
      .prepare(
        "INSERT INTO xp_events (ts, kind, amount, school_id, classroom_id, period_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        new Date().toISOString(),
        kind,
        amount,
        scope.schoolId,
        scope.classroomId,
        scope.periodId,
      );
    if (scope.periodId)
      sqlite
        .prepare("UPDATE periods SET xp_earned = xp_earned + ? WHERE id = ?")
        .run(amount, scope.periodId);
  })();
  return amount;
}

/**
 * At the bell: XP for whole minutes of active teaching. Idempotent per
 * period, so a resumed period only earns for minutes not yet counted.
 */
export function settleTeachingMinutes(
  handle: DbHandle,
  game: GameConfig,
  scope: XpScope,
  elapsedMs: number,
): number {
  const per = game.xp.teachingMinute ?? 0;
  if (per <= 0) return 0;
  const counted =
    (
      handle.sqlite
        .prepare(
          "SELECT coalesce(sum(amount), 0) AS n FROM xp_events WHERE period_id = ? AND kind = 'teachingMinute'",
        )
        .get(scope.periodId) as { n: number }
    ).n / per;
  const minutes = Math.floor(elapsedMs / 60_000) - counted;
  return minutes > 0 ? awardXp(handle, game, scope, "teachingMinute", minutes) : 0;
}

export function periodXp(
  handle: DbHandle,
  periodId: string,
): Array<{ kind: string; amount: number }> {
  return handle.sqlite
    .prepare(
      "SELECT kind, sum(amount) AS amount FROM xp_events WHERE period_id = ? GROUP BY kind ORDER BY amount DESC",
    )
    .all(periodId) as Array<{ kind: string; amount: number }>;
}

export function standing(handle: DbHandle, game: GameConfig): XpStanding {
  const total = (
    handle.sqlite.prepare("SELECT coalesce(sum(amount), 0) AS n FROM xp_events").get() as {
      n: number;
    }
  ).n;
  return rankFor(total, game.ranks);
}

export function rankFor(total: number, ranks: GameConfig["ranks"]): XpStanding {
  const sorted = [...ranks].sort((a, b) => a.minXp - b.minXp);
  let i = 0;
  while (i + 1 < sorted.length && sorted[i + 1]!.minXp <= total) i++;
  const here = sorted[i] ?? { name: "Teacher", minXp: 0 };
  const next = sorted[i + 1] ?? null;
  return {
    total,
    rank: here.name,
    next,
    progress: next ? (total - here.minXp) / (next.minXp - here.minXp) : 1,
  };
}
