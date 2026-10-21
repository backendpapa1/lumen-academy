// The ADHD loop's preferences (V3, VD7): the energy check-in can be turned
// off for good, and breaks are Pomodoro-shaped or off. Per-browser
// conveniences, so localStorage is fine; everything works without it.

export type BreakPlan = "off" | "25/5" | "15/3";

export interface RhythmPrefs {
  /** Ask "How's your energy?" before a class. */
  checkIn: boolean;
  breaks: BreakPlan;
}

const KEY = "lumen.rhythm";
const DEFAULTS: RhythmPrefs = { checkIn: true, breaks: "25/5" };

function read(): RhythmPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<RhythmPrefs>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export const rhythm = {
  prefs: read(),
  set(p: Partial<RhythmPrefs>) {
    this.prefs = { ...this.prefs, ...p };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.prefs));
    } catch {
      /* storage blocked: the choice lasts until reload */
    }
  },
  /** Work and break lengths in minutes, or null when breaks are off. */
  plan(): { work: number; rest: number } | null {
    const p = this.prefs.breaks;
    if (p === "off") return null;
    const [work, rest] = p.split("/").map(Number) as [number, number];
    return { work, rest };
  },
};
