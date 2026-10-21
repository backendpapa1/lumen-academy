import { wordSwaps } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";

// Learning my mishearings (V1, after Paul's recordings): when I fix the
// recogniser's words before sending, the swaps ("ash" → "hash") are kept per
// School and fed back to Whisper's prompt and to the transcript fixer.

export function recordCorrections(
  handle: DbHandle,
  schoolId: string,
  suggested: string,
  sent: string,
): Array<{ heard: string; meant: string }> {
  const swaps = wordSwaps(suggested, sent).filter(
    (s) => s.heard.length <= 40 && s.meant.length <= 40 && s.heard !== s.meant.toLowerCase(),
  );
  const now = new Date().toISOString();
  const upsert = handle.sqlite.prepare(
    `INSERT INTO speech_corrections (school_id, heard, meant, count, updated_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (school_id, heard, meant) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
  );
  handle.sqlite.transaction(() => {
    for (const s of swaps) upsert.run(schoolId, s.heard, s.meant, now);
  })();
  return swaps;
}

/** My most frequent mishearings for this School, most common first. */
export function knownMishearings(
  handle: DbHandle,
  schoolId: string,
  limit = 20,
): Array<{ heard: string; meant: string; count: number }> {
  return handle.sqlite
    .prepare(
      "SELECT heard, meant, count FROM speech_corrections WHERE school_id = ? ORDER BY count DESC, updated_at DESC LIMIT ?",
    )
    .all(schoolId, limit) as Array<{ heard: string; meant: string; count: number }>;
}
