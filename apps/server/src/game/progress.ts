import type { GameConfig, TeachingAnalysis } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { dayIn } from "./campus.js";

// Progress charts (V7-06): the v2 gate evidence, all from tables we already
// keep. Week by week: minutes taught, sessions, concepts mastered, the
// Director's average clarity and accuracy, and how much I taught by voice;
// plus which energy days went well (V3-02).

export interface WeekStats {
  /** Monday of the week, YYYY-MM-DD. */
  week: string;
  minutes: number;
  sessions: number;
  mastered: number;
  clarity: number | null;
  accuracy: number | null;
  /** Share of my teaching turns said aloud, 0..1 (null: no turns). */
  voice: number | null;
}

export interface EnergyStats {
  energy: "low" | "ok" | "high" | "unset";
  sessions: number;
  clarity: number | null;
  accuracy: number | null;
  minutes: number;
}

export interface Progress {
  weeks: WeekStats[];
  energy: EnergyStats[];
  totals: { minutes: number; sessions: number; mastered: number; turns: number };
}

const DAY = 86_400_000;

/** The Monday on or before a YYYY-MM-DD day. */
export function mondayOf(day: string): string {
  const t = Date.parse(day);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // 0 = Monday
  return new Date(t - dow * DAY).toISOString().slice(0, 10);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function progress(
  handle: DbHandle,
  game: GameConfig,
  now = new Date(),
  weeksBack = 8,
): Progress {
  const { sqlite } = handle;
  const tz = game.streak.timezone;
  const weekOf = (iso: string) => mondayOf(dayIn(tz, new Date(iso)));
  const thisWeek = mondayOf(dayIn(tz, now));
  const weeks = Array.from({ length: weeksBack }, (_, i) =>
    new Date(Date.parse(thisWeek) - (weeksBack - 1 - i) * 7 * DAY).toISOString().slice(0, 10),
  );
  const blank = (): WeekStats & { c: number[]; a: number[]; spoken: number; said: number } => ({
    week: "",
    minutes: 0,
    sessions: 0,
    mastered: 0,
    clarity: null,
    accuracy: null,
    voice: null,
    c: [],
    a: [],
    spoken: 0,
    said: 0,
  });
  const by = new Map(weeks.map((w) => [w, { ...blank(), week: w }]));

  const periods = sqlite
    .prepare(
      `SELECT p.id, p.started_at at, p.elapsed_ms ms, p.energy, (SELECT count(*) FROM turns t WHERE t.period_id = p.id) turns
       FROM periods p`,
    )
    .all() as Array<{ id: string; at: string; ms: number; energy: string | null; turns: number }>;
  const turns = sqlite
    .prepare("SELECT t.period_id pid, t.created_at at, t.analysis_json a FROM turns t")
    .all() as Array<{ pid: string; at: string; a: string }>;
  const teacher = sqlite
    .prepare(
      "SELECT created_at at, meta_json m FROM messages WHERE speaker = 'teacher' AND kind IN ('lecture','answer')",
    )
    .all() as Array<{ at: string; m: string | null }>;
  const mastered = sqlite
    .prepare("SELECT mastered_at at FROM concepts WHERE mastered_at IS NOT NULL")
    .all() as Array<{ at: string }>;

  const counted = periods.filter((p) => p.turns > 0 || p.ms >= 60_000);
  for (const p of counted) {
    const w = by.get(weekOf(p.at));
    if (!w) continue;
    w.minutes += p.ms / 60_000;
    w.sessions++;
  }
  const scoreOf = (json: string) => {
    try {
      return (JSON.parse(json) as TeachingAnalysis).teaching;
    } catch {
      return null;
    }
  };
  for (const t of turns) {
    const w = by.get(weekOf(t.at));
    const s = scoreOf(t.a);
    if (!w || !s) continue;
    w.c.push(s.clarity);
    w.a.push(s.accuracy);
  }
  for (const m of teacher) {
    const w = by.get(weekOf(m.at));
    if (!w) continue;
    w.said++;
    if (m.m && (JSON.parse(m.m) as { spoken?: boolean }).spoken) w.spoken++;
  }
  for (const m of mastered) {
    const w = by.get(weekOf(m.at));
    if (w) w.mastered++;
  }

  // Energy days (V3-02): how my teaching went on low, ok and high days.
  const perPeriod = new Map<string, { c: number[]; a: number[] }>();
  for (const t of turns) {
    const s = scoreOf(t.a);
    if (!s) continue;
    const e = perPeriod.get(t.pid) ?? { c: [], a: [] };
    e.c.push(s.clarity);
    e.a.push(s.accuracy);
    perPeriod.set(t.pid, e);
  }
  const energy = (["low", "ok", "high", "unset"] as const).map((level) => {
    const ps = counted.filter((p) => (p.energy ?? "unset") === level);
    const c = ps.flatMap((p) => perPeriod.get(p.id)?.c ?? []);
    const a = ps.flatMap((p) => perPeriod.get(p.id)?.a ?? []);
    return {
      energy: level,
      sessions: ps.length,
      clarity: mean(c),
      accuracy: mean(a),
      minutes: Math.round(ps.reduce((x, p) => x + p.ms, 0) / 60_000),
    };
  });

  return {
    weeks: weeks.map((w) => {
      const s = by.get(w)!;
      return {
        week: w,
        minutes: Math.round(s.minutes),
        sessions: s.sessions,
        mastered: s.mastered,
        clarity: mean(s.c),
        accuracy: mean(s.a),
        voice: s.said ? s.spoken / s.said : null,
      };
    }),
    energy,
    totals: {
      minutes: Math.round(counted.reduce((x, p) => x + p.ms, 0) / 60_000),
      sessions: counted.length,
      mastered: mastered.length,
      turns: turns.length,
    },
  };
}
