import type { GameConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { dayIn } from "./campus.js";
import { schoolConceptStatuses } from "./schoolStatus.js";

// Goal-shaped curriculum (V6-07): "I have an exam on Friday" becomes a plan.
// What's left (not yet mastered) in prerequisite order, weighted by difficulty
// and by how far each concept is from done, split across the days before the
// exam. Minutes per concept come from my own history (turns it took to teach
// concepts so far), not a guess. Pure server logic; no LLM.

export interface PlanConcept {
  id: string;
  title: string;
  status: string;
  minutes: number;
}
export interface PlanDay {
  date: string;
  label: string;
  concepts: PlanConcept[];
  minutes: number;
}
export interface StudyPlan {
  examDate: string;
  daysLeft: number;
  days: PlanDay[];
  /** Minutes a day the plan asks for (more than an hour reads as a warning). */
  perDay: number;
  /** Already mastered: nothing to plan. */
  done: number;
}

const DAY = 86_400_000;
/** About how long a teaching turn takes, in minutes. */
const MINUTES_PER_TURN = 0.75;
/** How much of a concept is left to do, by status. */
const LEFT: Record<string, number> = { untaught: 1, weak: 0.8, taught: 0.5, mastered: 0 };

/** Concepts in teaching order with prerequisites always first (stable topological sort). */
export function prerequisiteOrder<T extends { id: string; prereqs: string[] }>(xs: T[]): T[] {
  const byId = new Map(xs.map((x) => [x.id, x]));
  const out: T[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (x: T) => {
    if (state.get(x.id) === "done" || state.get(x.id) === "visiting") return; // cycles: keep order
    state.set(x.id, "visiting");
    for (const p of x.prereqs) {
      const q = byId.get(p);
      if (q) visit(q);
    }
    state.set(x.id, "done");
    out.push(x);
  };
  for (const x of xs) visit(x);
  return out;
}

export function studyPlan(
  handle: DbHandle,
  game: GameConfig,
  schoolId: string,
  now = new Date(),
): StudyPlan | null {
  const { sqlite } = handle;
  const school = sqlite.prepare("SELECT exam_date d FROM schools WHERE id = ?").get(schoolId) as
    { d: string | null } | undefined;
  if (!school?.d) return null;
  const tz = game.streak.timezone;
  const today = dayIn(tz, now);
  const daysLeft = Math.max(0, Math.round((Date.parse(school.d) - Date.parse(today)) / DAY));
  const rows = sqlite
    .prepare(
      `SELECT k.id, k.title, k.difficulty d, k.prerequisites_json p FROM concepts k JOIN modules m ON m.id = k.module_id
       WHERE m.school_id = ? ORDER BY m.ord, k.ord`,
    )
    .all(schoolId) as Array<{ id: string; title: string; d: number; p: string }>;
  const status = schoolConceptStatuses(handle, schoolId, game.status);
  // My pace so far: mean teaching turns over the concepts I've taught.
  const taught = Object.values(status).filter((s) => s.turns > 0);
  const turnsPerConcept = taught.length
    ? taught.reduce((a, s) => a + s.turns, 0) / taught.length
    : 8;
  const ordered = prerequisiteOrder(
    rows.map((r) => ({ ...r, prereqs: JSON.parse(r.p) as string[] })),
  );
  const todo = ordered
    .map((r) => {
      const st = status[r.id]?.status ?? "untaught";
      const left = LEFT[st] ?? 1;
      const difficulty = Math.max(1, Math.min(5, r.d || 2));
      return {
        id: r.id,
        title: r.title,
        status: st,
        minutes: Math.max(
          5,
          Math.round(turnsPerConcept * MINUTES_PER_TURN * (difficulty / 2.5) * left),
        ),
      };
    })
    .filter((c) => c.status !== "mastered");
  // Study days: from today up to the day before the exam (the exam day is for a light review).
  const n = Math.max(1, daysLeft);
  const total = todo.reduce((a, c) => a + c.minutes, 0);
  const target = total / n;
  const days: PlanDay[] = Array.from({ length: n }, (_, i) => {
    const date = new Date(Date.parse(today) + i * DAY).toISOString().slice(0, 10);
    return {
      date,
      label:
        i === 0
          ? "Today"
          : i === 1
            ? "Tomorrow"
            : new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(
                new Date(date),
              ),
      concepts: [],
      minutes: 0,
    };
  });
  // Greedy in order: a day takes concepts until it reaches its share of the minutes.
  let d = 0;
  let spent = 0;
  for (const c of todo) {
    if (d < n - 1 && spent >= target * (d + 1)) d++;
    days[d]!.concepts.push(c);
    days[d]!.minutes += c.minutes;
    spent += c.minutes;
  }
  return {
    examDate: school.d,
    daysLeft,
    days,
    perDay: Math.round(target),
    done: rows.length - todo.length,
  };
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * "friday", "next tuesday", "tomorrow", "in 5 days", "in 2 weeks" or 2026-10-30
 * → YYYY-MM-DD, counted from today (in the streak's time zone). Null if unclear.
 */
export function parseExamDate(text: string, today: string): string | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/^(on|by|this)\s+/, "");
  const at = (days: number) => new Date(Date.parse(today) + days * DAY).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return Number.isNaN(Date.parse(t)) ? null : t;
  if (t === "today") return today;
  if (t === "tomorrow") return at(1);
  const rel = /^in\s+(\d{1,3})\s+(day|days|week|weeks)$/.exec(t);
  if (rel) return at(Number(rel[1]) * (rel[2]!.startsWith("week") ? 7 : 1));
  if (t === "next week") return at(7);
  const wd = /^(next\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/.exec(t);
  if (wd) {
    const target = WEEKDAYS.findIndex((d) => d.startsWith(wd[2]!));
    const now = new Date(Date.parse(today)).getUTCDay();
    let ahead = (target - now + 7) % 7 || 7;
    if (wd[1]) ahead += ahead < 7 ? 7 : 0;
    return at(ahead);
  }
  return null;
}
