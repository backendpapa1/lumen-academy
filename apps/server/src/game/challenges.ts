import type { GameConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { newId } from "../db/ids.js";
import { dayIn } from "./campus.js";
import { mondayOf } from "./progress.js";
import { awardXp } from "./xp.js";

// Weekly challenges (V7-04): one opt-in challenge a week, a new one each
// Monday. The server checks it on my own turns; the reward is bonus XP and a
// sticker from the class where I finished it.

export const CHALLENGES = {
  no_jargon: {
    title: "Teach without jargon",
    blurb: "Three classes this week with almost no subject terms you haven't defined on the wall.",
    of: 3,
  },
  three_examples: {
    title: "Three examples per concept",
    blurb: "Give at least three worked examples on two different concepts this week.",
    of: 2,
  },
  everyone_speaks: {
    title: "Everyone speaks",
    blurb: "In one class, hear from every student at least once.",
    of: 1,
  },
  socratic: {
    title: "A Socratic class",
    blurb: "Teach one Socratic class this week, with at least five questions.",
    of: 1,
  },
} as const;
export type ChallengeKind = keyof typeof CHALLENGES;
const KINDS = Object.keys(CHALLENGES) as ChallengeKind[];

const EXAMPLE =
  /\b(for example|for instance|e\.g\.|say you have|let'?s say|suppose|such as|take a)\b/i;
/** Undefined subject terms per 100 words, at most, for a "jargon-free" class. */
export const JARGON_LIMIT = 2;

const DAY = 86_400_000;

/** ISO week label (2026-W43) for a Monday. */
function isoWeek(monday: string): string {
  const d = new Date(`${monday}T00:00:00Z`);
  const thursday = new Date(d.getTime() + 3 * DAY);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / DAY + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function thisWeek(game: GameConfig, now = new Date()) {
  const monday = mondayOf(dayIn(game.streak.timezone, now));
  const week = isoWeek(monday);
  // A different challenge each week, in a fixed rotation.
  const n = Number(week.slice(-2)) + Number(week.slice(0, 4));
  return { week, monday, kind: KINDS[n % KINDS.length]! };
}

/** Subject vocabulary (key facts and titles) and the terms I've defined. */
function vocab(handle: DbHandle) {
  const subject = new Set<string>();
  for (const r of handle.sqlite
    .prepare("SELECT title, key_facts_json k FROM concepts")
    .all() as Array<{
    title: string;
    k: string;
  }>)
    for (const w of `${r.title} ${(JSON.parse(r.k) as string[]).join(" ")}`
      .toLowerCase()
      .match(/[a-z][a-z0-9-]{5,}/g) ?? [])
      subject.add(w);
  const defined = new Set(
    (
      handle.sqlite.prepare("SELECT term FROM glossary_terms").all() as Array<{ term: string }>
    ).flatMap((t) => t.term.split(/\s+/)),
  );
  return { subject, defined };
}

/** The subject terms in what I said that aren't on the glossary wall (the jargon filter). */
export function undefinedTerms(handle: DbHandle, text: string): string[] {
  const { subject, defined } = vocab(handle);
  return [...new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{5,}/g) ?? [])].filter(
    (w) => subject.has(w) && !defined.has(w),
  );
}

export function challengeProgress(handle: DbHandle, kind: ChallengeKind, monday: string): number {
  const { sqlite } = handle;
  const from = `${monday}T00:00:00`;
  const to = new Date(Date.parse(monday) + 7 * DAY).toISOString();
  const periods = sqlite
    .prepare(
      "SELECT id, kind, classroom_id c FROM periods WHERE started_at >= ? AND started_at < ?",
    )
    .all(from, to) as Array<{ id: string; kind: string; c: string }>;
  const said = (pid: string) =>
    sqlite
      .prepare(
        "SELECT text, concept_id cid FROM messages WHERE period_id = ? AND speaker = 'teacher' AND kind IN ('lecture','answer')",
      )
      .all(pid) as Array<{ text: string; cid: string | null }>;
  if (kind === "no_jargon") {
    const { subject, defined } = vocab(handle);
    return periods.filter((p) => {
      const lines = said(p.id);
      if (lines.length < 5) return false;
      let words = 0;
      let hits = 0;
      for (const l of lines) {
        words += l.text.split(/\s+/).length;
        for (const w of new Set(l.text.toLowerCase().match(/[a-z][a-z0-9-]{5,}/g) ?? []))
          if (subject.has(w) && !defined.has(w)) hits++;
      }
      return words > 0 && (hits / words) * 100 <= JARGON_LIMIT;
    }).length;
  }
  if (kind === "three_examples") {
    const per = new Map<string, number>();
    for (const p of periods)
      for (const l of said(p.id))
        if (l.cid && EXAMPLE.test(l.text)) per.set(l.cid, (per.get(l.cid) ?? 0) + 1);
    return [...per.values()].filter((n) => n >= 3).length;
  }
  if (kind === "everyone_speaks")
    return periods.filter((p) => {
      const roster = sqlite
        .prepare(
          "SELECT id FROM cadets WHERE classroom_id = ? AND status IN ('enrolled','transferred_in')",
        )
        .all(p.c) as Array<{ id: string }>;
      if (roster.length < 2) return false;
      const spoke = new Set(
        (
          sqlite
            .prepare("SELECT DISTINCT speaker s FROM messages WHERE period_id = ?")
            .all(p.id) as Array<{ s: string }>
        ).map((r) => r.s),
      );
      return roster.every((c) => spoke.has(c.id));
    }).length;
  // socratic
  return periods.filter(
    (p) =>
      p.kind === "socratic" &&
      (
        sqlite.prepare("SELECT count(*) n FROM turns WHERE period_id = ?").get(p.id) as {
          n: number;
        }
      ).n >= 5,
  ).length;
}

export interface ChallengeView {
  week: string;
  kind: ChallengeKind;
  title: string;
  blurb: string;
  of: number;
  accepted: boolean;
  done: number;
  completed: boolean;
}

/** This week's challenge, its progress, and (once) the reward when it's done. */
export function currentChallenge(
  handle: DbHandle,
  game: GameConfig,
  now = new Date(),
): ChallengeView {
  const { week, monday, kind } = thisWeek(game, now);
  const row = handle.sqlite
    .prepare("SELECT id, kind, completed_at c FROM challenges WHERE week = ?")
    .get(week) as { id: string; kind: ChallengeKind; c: string | null } | undefined;
  const k = row?.kind ?? kind;
  const info = CHALLENGES[k];
  const done = row ? Math.min(info.of, challengeProgress(handle, k, monday)) : 0;
  let completed = !!row?.c;
  if (row && !row.c && done >= info.of) {
    completed = true;
    reward(handle, game, row.id, k, monday);
  }
  return {
    week,
    kind: k,
    title: info.title,
    blurb: info.blurb,
    of: info.of,
    accepted: !!row,
    done,
    completed,
  };
}

export function acceptChallenge(
  handle: DbHandle,
  game: GameConfig,
  now = new Date(),
): ChallengeView {
  const { week, kind } = thisWeek(game, now);
  handle.sqlite
    .prepare("INSERT OR IGNORE INTO challenges (id, week, kind, accepted_at) VALUES (?, ?, ?, ?)")
    .run(newId("challenge"), week, kind, now.toISOString());
  return currentChallenge(handle, game, now);
}

/** Bonus XP, and a sticker from a student in the class I taught most recently this week. */
function reward(
  handle: DbHandle,
  game: GameConfig,
  id: string,
  kind: ChallengeKind,
  monday: string,
) {
  const { sqlite } = handle;
  sqlite
    .prepare("UPDATE challenges SET completed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
  const last = sqlite
    .prepare(
      `SELECT p.id pid, p.classroom_id c, r.school_id s FROM periods p JOIN classrooms r ON r.id = p.classroom_id
       WHERE p.started_at >= ? ORDER BY p.started_at DESC LIMIT 1`,
    )
    .get(`${monday}T00:00:00`) as { pid: string; c: string; s: string } | undefined;
  if (!last) return;
  awardXp(
    handle,
    game,
    { schoolId: last.s, classroomId: last.c, periodId: last.pid },
    "challengeDone",
  );
  const giver = sqlite
    .prepare(
      "SELECT id FROM cadets WHERE classroom_id = ? AND status IN ('enrolled','transferred_in') ORDER BY random() LIMIT 1",
    )
    .get(last.c) as { id: string } | undefined;
  if (giver)
    sqlite
      .prepare(
        "INSERT INTO stickers (id, classroom_id, period_id, cadet_id, kind, reason, created_at) VALUES (?, ?, ?, ?, 'challenge', ?, ?)",
      )
      .run(
        newId("sticker"),
        last.c,
        last.pid,
        giver.id,
        `Weekly challenge: ${CHALLENGES[kind].title}`,
        new Date().toISOString(),
      );
}
