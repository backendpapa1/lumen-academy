import type { DbHandle } from "../db/client.js";

// Whisper's initial prompt (V1-S1): the School's own terms, so "Merkle root"
// isn't heard as "Merkel route". Concept titles first, then distinctive words
// from the key facts (capitalised, hyphenated, with digits, or long).

export function glossaryFor(handle: DbHandle, schoolId: string, maxChars: number): string {
  const rows = handle.sqlite
    .prepare(
      `SELECT c.title, c.key_facts_json AS facts FROM concepts c JOIN modules m ON m.id = c.module_id
       WHERE m.school_id = ? ORDER BY m.ord, c.ord`,
    )
    .all(schoolId) as Array<{ title: string; facts: string }>;
  const terms = new Map<string, string>();
  const add = (t: string) => {
    const k = t.toLowerCase();
    if (t.length > 2 && !terms.has(k)) terms.set(k, t);
  };
  for (const r of rows) add(r.title.replace(/[:(].*$/, "").trim());
  for (const r of rows) {
    let facts: string[] = [];
    try {
      facts = JSON.parse(r.facts) as string[];
    } catch {
      /* skip */
    }
    for (const f of facts)
      for (const w of f.match(/\b[\p{L}\p{N}][\p{L}\p{N}-]*\b/gu) ?? [])
        if (/[A-Z].*[A-Z]|-|\d/.test(w) || (/^[A-Z]/.test(w) && w.length > 3) || w.length > 11)
          add(w);
  }
  let out = "Glossary:";
  for (const t of terms.values()) {
    if (out.length + t.length + 2 > maxChars) break;
    out += ` ${t},`;
  }
  return out.endsWith(",") ? `${out.slice(0, -1)}.` : "";
}
