import type { GameConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";

// Everyday interests (V4-04). New students get theirs from the Registrar;
// students who enrolled before V4 get two from game.yaml, picked from their id
// so it's stable, free, and never an LLM call.

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return h >>> 0;
}

export function defaultInterests(cadetId: string, list: string[]): string[] {
  if (!list.length) return [];
  const a = hash(cadetId) % list.length;
  const b = (a + 1 + (hash(`${cadetId}:2`) % Math.max(1, list.length - 1))) % list.length;
  return a === b ? [list[a]!] : [list[a]!, list[b]!];
}

export function interestsOf(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 2) : [];
  } catch {
    return [];
  }
}

/** Gives every student without interests a stable pair. Returns how many it filled. */
export function backfillInterests(handle: DbHandle, game: GameConfig): number {
  const rows = handle.sqlite
    .prepare("SELECT id FROM cadets WHERE interests_json = '[]' OR interests_json = ''")
    .all() as Array<{ id: string }>;
  const set = handle.sqlite.prepare("UPDATE cadets SET interests_json = ? WHERE id = ?");
  handle.sqlite.transaction(() => {
    for (const r of rows) set.run(JSON.stringify(defaultInterests(r.id, game.interests)), r.id);
  })();
  return rows.length;
}
