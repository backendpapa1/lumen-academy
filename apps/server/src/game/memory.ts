import type { GameConfig } from "@lumen/shared";

// Forgetting (V2-01, VD5). The ledger stores what a cadet understood when it
// was last reinforced; what it *recalls* now decays toward a floor with a
// half-life that grows with each spaced review. Computed at read time, so a
// laptop that slept for a week still forgets correctly. The server does this,
// never the LLM.

type Memory = GameConfig["memory"];

const DAY_MS = 86_400_000;

/** What's recalled now of a memory of strength `c`. */
export function recall(
  c: number,
  lastAt: string | null | undefined,
  stabilityDays: number | null | undefined,
  now: Date,
  cfg: Memory,
): number {
  if (!lastAt || c <= 0) return c;
  const days = Math.max(0, (now.getTime() - Date.parse(lastAt)) / DAY_MS);
  const half = stabilityDays ?? cfg.halfLifeDays;
  return c * (cfg.floor + (1 - cfg.floor) * 0.5 ** (days / half));
}

/** Share of its strength a memory still holds (1 = fresh), for "fading" checks. */
export function retention(
  lastAt: string | null | undefined,
  stabilityDays: number | null | undefined,
  now: Date,
  cfg: Memory,
): number {
  return recall(1, lastAt, stabilityDays, now, cfg);
}

/**
 * Teaching it again: start from what's recalled now (not the old peak), and if
 * this is a spaced review of something already learned, it'll last longer.
 */
export function reinforce(
  row:
    | { comprehension: number; lastTaughtAt: string | null; stabilityDays: number | null }
    | undefined,
  now: Date,
  cfg: Memory,
): { base: number; stabilityDays: number } {
  if (!row?.lastTaughtAt) return { base: row?.comprehension ?? 0, stabilityDays: cfg.halfLifeDays };
  const half = row.stabilityDays ?? cfg.halfLifeDays;
  const hours = (now.getTime() - Date.parse(row.lastTaughtAt)) / 3_600_000;
  const spaced = hours >= cfg.spacedAfterHours && row.comprehension > 0;
  return {
    base: recall(row.comprehension, row.lastTaughtAt, half, now, cfg),
    stabilityDays: spaced ? Math.min(cfg.maxHalfLifeDays, half * cfg.growth) : half,
  };
}
