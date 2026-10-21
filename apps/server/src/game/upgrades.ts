import { UPGRADES, upgradeSlots, type GameConfig, type UpgradeItem } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { standing } from "./xp.js";

// Room upgrades (V7-01): slots come with rank; I choose the items, per class.

export interface UpgradeState {
  slots: number;
  rank: string;
  chosen: UpgradeItem[];
}

const known = new Set<string>(UPGRADES.map((u) => u.item));

export function upgradeState(
  handle: DbHandle,
  game: GameConfig,
  classroomId: string,
): UpgradeState {
  const st = standing(handle, game);
  const rankIndex = [...game.ranks]
    .sort((a, b) => a.minXp - b.minXp)
    .findIndex((r) => r.name === st.rank);
  const chosen = (
    handle.sqlite
      .prepare("SELECT item FROM room_upgrades WHERE classroom_id = ? ORDER BY placed_at")
      .all(classroomId) as Array<{ item: string }>
  )
    .map((r) => r.item)
    .filter((i): i is UpgradeItem => known.has(i));
  return { slots: upgradeSlots(rankIndex), rank: st.rank, chosen };
}

/** Places an item if a slot is free. Returns the new state, or an error in plain words. */
export function placeUpgrade(
  handle: DbHandle,
  game: GameConfig,
  classroomId: string,
  item: string,
): UpgradeState | { error: string } {
  if (!known.has(item)) return { error: "No such upgrade." };
  const st = upgradeState(handle, game, classroomId);
  if (st.chosen.includes(item as UpgradeItem)) return st;
  if (st.chosen.length >= st.slots)
    return {
      error: `All ${st.slots} slots are used at ${st.rank}. Remove one, or rank up for more.`,
    };
  handle.sqlite
    .prepare("INSERT INTO room_upgrades (classroom_id, item, placed_at) VALUES (?, ?, ?)")
    .run(classroomId, item, new Date().toISOString());
  return upgradeState(handle, game, classroomId);
}

export function removeUpgrade(
  handle: DbHandle,
  game: GameConfig,
  classroomId: string,
  item: string,
) {
  handle.sqlite
    .prepare("DELETE FROM room_upgrades WHERE classroom_id = ? AND item = ?")
    .run(classroomId, item);
  return upgradeState(handle, game, classroomId);
}

/** Items placed since this class last met: the students notice them. */
export function newSinceLastPeriod(
  handle: DbHandle,
  classroomId: string,
  periodId: string,
): UpgradeItem[] {
  const last = handle.sqlite
    .prepare(
      "SELECT max(started_at) t FROM periods WHERE classroom_id = ? AND id != ? AND ended_at IS NOT NULL",
    )
    .get(classroomId, periodId) as { t: string | null };
  return (
    handle.sqlite
      .prepare("SELECT item FROM room_upgrades WHERE classroom_id = ? AND placed_at > ?")
      .all(classroomId, last.t ?? "") as Array<{ item: string }>
  )
    .map((r) => r.item)
    .filter((i): i is UpgradeItem => known.has(i));
}
