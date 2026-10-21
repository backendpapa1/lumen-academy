import type { GameConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { dayIn } from "./campus.js";
import { hairOf, registerOf } from "./looks.js";

// The study hall as preparation for class: the concept each class meets next
// and the passages behind it, what to look up (questions left hanging, my
// mistakes, what the class believes wrongly), a student's question while I
// read, and the minutes that count toward the streak. The server picks and
// counts; only the Explanation Coach is a model.

export interface StudyConcept {
  id: string;
  title: string;
  summary: string;
  keyFacts: string[];
  misconceptions: string[];
}

export interface Passage {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  page: number | null;
  heading: string | null;
  excerpt: string;
}

export interface ClassPrep {
  classroomId: string;
  classroomName: string;
  concept: StudyConcept;
  why: "current" | "next" | "weak";
  passages: Passage[];
  /** My quotes and rehearsals for it so far. */
  studied: { quotes: number; explanations: number };
}

export interface Lookup {
  id: string;
  kind: "question" | "mistake" | "misconception";
  text: string;
  /** Who asked, or how many students believe it. */
  who: string | null;
  conceptId: string | null;
  conceptTitle: string | null;
}

export interface Classmate {
  id: string;
  name: string;
  archetype: string;
  hair: string;
  register: string;
}

type ConceptRow = {
  id: string;
  title: string;
  summary: string;
  kf: string;
  mc: string;
};

const parse = (s: string): string[] => {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const toConcept = (r: ConceptRow): StudyConcept => ({
  id: r.id,
  title: r.title,
  summary: r.summary,
  keyFacts: parse(r.kf),
  misconceptions: parse(r.mc),
});

const CONCEPT_COLS = "c.id, c.title, c.summary, c.key_facts_json kf, c.misconceptions_json mc";

export function conceptById(handle: DbHandle, schoolId: string, id: string): StudyConcept | null {
  const r = handle.sqlite
    .prepare(
      `SELECT ${CONCEPT_COLS} FROM concepts c JOIN modules m ON m.id = c.module_id WHERE c.id = ? AND m.school_id = ?`,
    )
    .get(id, schoolId) as ConceptRow | undefined;
  return r ? toConcept(r) : null;
}

/** The passages a concept was built from, in reading order. */
export function passagesFor(handle: DbHandle, conceptId: string, max = 6): Passage[] {
  return (
    handle.sqlite
      .prepare(
        `SELECT k.id chunkId, k.source_id sourceId, s.title sourceTitle, k.page_from page, k.heading_path heading, k.text
         FROM concept_citations cc JOIN chunks k ON k.id = cc.chunk_id JOIN sources s ON s.id = k.source_id
         WHERE cc.concept_id = ? ORDER BY s.created_at, k.ord LIMIT ?`,
      )
      .all(conceptId, max) as Array<Omit<Passage, "excerpt"> & { text: string }>
  ).map(({ text, ...p }) => ({
    ...p,
    heading: p.heading?.split(" > ").at(-1) ?? null,
    excerpt: text.length > 220 ? `${text.slice(0, 220).trimEnd()}…` : text,
  }));
}

function studiedCounts(handle: DbHandle, conceptId: string) {
  const { sqlite } = handle;
  const n = (sql: string) => (sqlite.prepare(sql).get(conceptId) as { n: number }).n;
  return {
    quotes: n("SELECT count(*) n FROM study_quotes WHERE concept_id = ?"),
    explanations: n("SELECT count(*) n FROM study_explanations WHERE concept_id = ?"),
  };
}

/**
 * Each active class's next concept: the one it's on, else the first in the
 * curriculum the class hasn't met, else its weakest.
 */
export function prepFor(handle: DbHandle, game: GameConfig, schoolId: string): ClassPrep[] {
  const { sqlite } = handle;
  const rooms = sqlite
    .prepare(
      "SELECT id, name, current_concept_id cur FROM classrooms WHERE school_id = ? AND status = 'active' ORDER BY created_at",
    )
    .all(schoolId) as Array<{ id: string; name: string; cur: string | null }>;
  const out: ClassPrep[] = [];
  for (const room of rooms) {
    let why: ClassPrep["why"] = "current";
    let row = room.cur
      ? (sqlite.prepare(`SELECT ${CONCEPT_COLS} FROM concepts c WHERE c.id = ?`).get(room.cur) as
          ConceptRow | undefined)
      : undefined;
    if (!row) {
      why = "next";
      row = sqlite
        .prepare(
          `SELECT ${CONCEPT_COLS} FROM concepts c JOIN modules m ON m.id = c.module_id
           WHERE m.school_id = ? AND NOT EXISTS (
             SELECT 1 FROM ledger_entries l JOIN cadets d ON d.id = l.cadet_id
             WHERE l.concept_id = c.id AND d.classroom_id = ? AND l.exposures > 0)
           ORDER BY m.ord, c.ord LIMIT 1`,
        )
        .get(schoolId, room.id) as ConceptRow | undefined;
    }
    if (!row) {
      why = "weak";
      row = sqlite
        .prepare(
          `SELECT ${CONCEPT_COLS} FROM concepts c JOIN modules m ON m.id = c.module_id
           JOIN ledger_entries l ON l.concept_id = c.id JOIN cadets d ON d.id = l.cadet_id
           WHERE m.school_id = ? AND d.classroom_id = ? AND d.status = 'enrolled'
           GROUP BY c.id HAVING avg(l.comprehension) < ? ORDER BY avg(l.comprehension) LIMIT 1`,
        )
        .get(schoolId, room.id, game.comprehension.understoodAt) as ConceptRow | undefined;
    }
    if (!row) continue;
    out.push({
      classroomId: room.id,
      classroomName: room.name,
      concept: toConcept(row),
      why,
      passages: passagesFor(handle, row.id),
      studied: studiedCounts(handle, row.id),
    });
  }
  return out;
}

const LOOKED_UP = (schoolId: string) => `studyLookedUp:${schoolId}`;

export function lookedUp(handle: DbHandle, schoolId: string): string[] {
  const r = handle.sqlite
    .prepare("SELECT value_json v FROM settings WHERE key = ?")
    .get(LOOKED_UP(schoolId)) as { v: string } | undefined;
  return r ? parse(r.v) : [];
}

export function markLookedUp(handle: DbHandle, schoolId: string, id: string): void {
  const ids = [...new Set([...lookedUp(handle, schoolId), id])].slice(-500);
  handle.sqlite
    .prepare(
      "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(LOOKED_UP(schoolId), JSON.stringify(ids));
}

/**
 * Things to look up before the next class: students' questions I left
 * hanging (no reply from me before the bell), my unresolved mistakes, and the
 * misconceptions most of a class holds. Newest first, a few of each.
 */
export function lookupsFor(handle: DbHandle, schoolId: string, max = 4): Lookup[] {
  const { sqlite } = handle;
  const done = new Set(lookedUp(handle, schoolId));
  const out: Lookup[] = [];

  const hanging = sqlite
    .prepare(
      `SELECT q.id, q.text, d.name who, q.concept_id cid, c.title ct FROM messages q
       JOIN periods p ON p.id = q.period_id JOIN classrooms r ON r.id = p.classroom_id
       JOIN cadets d ON d.id = q.speaker LEFT JOIN concepts c ON c.id = q.concept_id
       WHERE r.school_id = ? AND q.kind = 'question' AND p.ended_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM messages t WHERE t.period_id = q.period_id
           AND t.speaker = 'teacher' AND t.created_at > q.created_at)
       ORDER BY q.created_at DESC LIMIT 20`,
    )
    .all(schoolId) as Array<{
    id: string;
    text: string;
    who: string;
    cid: string | null;
    ct: string | null;
  }>;
  for (const q of hanging.filter((q) => !done.has(q.id)).slice(0, max))
    out.push({
      id: q.id,
      kind: "question",
      text: q.text,
      who: q.who,
      conceptId: q.cid,
      conceptTitle: q.ct,
    });

  const mistakes = sqlite
    .prepare(
      `SELECT te.id, te.claim, te.concept_id cid, c.title ct FROM teacher_errors te
       JOIN turns t ON t.id = te.turn_id JOIN periods p ON p.id = t.period_id
       JOIN classrooms r ON r.id = p.classroom_id LEFT JOIN concepts c ON c.id = te.concept_id
       WHERE r.school_id = ? AND te.resolved = 0 ORDER BY t.created_at DESC LIMIT 20`,
    )
    .all(schoolId) as Array<{ id: string; claim: string; cid: string | null; ct: string | null }>;
  for (const m of mistakes.filter((m) => !done.has(m.id)).slice(0, max))
    out.push({
      id: m.id,
      kind: "mistake",
      text: `You said: “${m.claim}”`,
      who: null,
      conceptId: m.cid,
      conceptTitle: m.ct,
    });

  // Misconceptions held by students now, counted per concept.
  const held = sqlite
    .prepare(
      `SELECT l.misconceptions_json mj, c.id cid, c.title ct FROM ledger_entries l
       JOIN cadets d ON d.id = l.cadet_id JOIN classrooms r ON r.id = d.classroom_id
       JOIN concepts c ON c.id = l.concept_id
       WHERE r.school_id = ? AND r.status = 'active' AND d.status = 'enrolled' AND l.misconceptions_json != '[]'`,
    )
    .all(schoolId) as Array<{ mj: string; cid: string; ct: string }>;
  const counts = new Map<string, { text: string; cid: string; ct: string; n: number }>();
  for (const h of held)
    for (const text of parse(h.mj)) {
      const key = `${h.cid}|${text.toLowerCase()}`;
      const c = counts.get(key) ?? { text, cid: h.cid, ct: h.ct, n: 0 };
      c.n++;
      counts.set(key, c);
    }
  for (const [key, c] of [...counts].sort((a, b) => b[1].n - a[1].n)) {
    const id = `mis:${key}`;
    if (done.has(id) || out.filter((o) => o.kind === "misconception").length >= max) continue;
    out.push({
      id,
      kind: "misconception",
      text: c.text,
      who: c.n === 1 ? "1 student believes this" : `${c.n} students believe this`,
      conceptId: c.cid,
      conceptTitle: c.ct,
    });
  }
  return out;
}

/** A few students from the School's classes, to study at the next desks. */
export function classmatesFor(handle: DbHandle, schoolId: string, max = 2): Classmate[] {
  const rows = handle.sqlite
    .prepare(
      `SELECT d.id, d.name, d.archetype, d.traits_json t FROM cadets d JOIN classrooms r ON r.id = d.classroom_id
       WHERE r.school_id = ? AND r.status = 'active' AND d.status = 'enrolled' ORDER BY d.id`,
    )
    .all(schoolId) as Array<{ id: string; name: string; archetype: string; t: string }>;
  // A different pair each day, the same all day.
  const day = Number(dayIn("UTC", new Date()).replaceAll("-", ""));
  const start = rows.length ? day % rows.length : 0;
  return [...rows.slice(start), ...rows.slice(0, start)].slice(0, max).map((r) => ({
    id: r.id,
    name: r.name,
    archetype: r.archetype,
    hair: hairOf(r.t),
    register: registerOf(r.id, r.t),
  }));
}

/** How each kind of student asks about an idea (no model: it only needs the title). */
const ASKS: Record<string, string[]> = {
  skeptic: ["Why should I believe {t} works the way the book says?", "What's the catch with {t}?"],
  literalist: ["What exactly does {t} mean, word for word?", "Can you define {t} in one sentence?"],
  pragmatist: ["When would I actually use {t}?", "What's {t} for, in real life?"],
  connector: ["Is {t} like something we've already covered?", "How does {t} fit with the rest?"],
  overachiever: ["What happens if {t} goes wrong?", "Is there more to {t} than the basics?"],
  quiet: ["Sorry, I didn't get {t}. What is it?", "Could you explain {t} again, simply?"],
};
const DEFAULT_ASKS = ["Wait, so what's {t}?", "Can you give me an example of {t}?"];

export function buddyQuestion(archetype: string, title: string, seed: number): string {
  const asks = ASKS[archetype] ?? DEFAULT_ASKS;
  return asks[Math.abs(seed) % asks.length]!.replace("{t}", title);
}

/** Concepts the study hall can ask about: those cited by these passages, else the School's taught ones. */
export function conceptsAround(handle: DbHandle, schoolId: string, chunkIds: string[]): string[] {
  const { sqlite } = handle;
  if (chunkIds.length) {
    const ids = sqlite
      .prepare(
        `SELECT DISTINCT cc.concept_id id FROM concept_citations cc JOIN concepts c ON c.id = cc.concept_id
         JOIN modules m ON m.id = c.module_id
         WHERE m.school_id = ? AND cc.chunk_id IN (SELECT value FROM json_each(?))`,
      )
      .all(schoolId, JSON.stringify(chunkIds.slice(0, 400))) as Array<{ id: string }>;
    if (ids.length) return ids.map((r) => r.id);
  }
  return (
    sqlite
      .prepare(
        `SELECT c.id FROM concepts c JOIN modules m ON m.id = c.module_id
         WHERE m.school_id = ? ORDER BY (c.status = 'untaught'), m.ord, c.ord LIMIT 40`,
      )
      .all(schoolId) as Array<{ id: string }>
  ).map((r) => r.id);
}

/** Focused study minutes today, in the streak's time zone. */
export function studyMinutesToday(handle: DbHandle, game: GameConfig, now = new Date()): number {
  const tz = game.streak.timezone;
  const today = dayIn(tz, now);
  const rows = handle.sqlite
    .prepare("SELECT started_at s, minutes m FROM study_sessions WHERE started_at >= ?")
    .all(new Date(now.getTime() - 36 * 3_600_000).toISOString()) as Array<{ s: string; m: number }>;
  return rows.filter((r) => dayIn(tz, new Date(r.s)) === today).reduce((n, r) => n + r.m, 0);
}

/** When study sessions long enough to count toward the streak ended (or last ticked). */
export function studyStreakTimes(handle: DbHandle, game: GameConfig): string[] {
  return (
    handle.sqlite
      .prepare("SELECT coalesce(ended_at, started_at) t FROM study_sessions WHERE minutes >= ?")
      .all(game.study.streakMinutes) as Array<{ t: string }>
  ).map((r) => r.t);
}
