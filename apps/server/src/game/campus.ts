import type { GameConfig } from "@lumen/shared";
import type { AssetService } from "../assets/service.js";
import type { DbHandle } from "../db/client.js";
import { schoolConceptStatuses } from "./schoolStatus.js";

// Campus progression (docs/02 §7.2–7.4, PRD P-2, P-3, P-4): building tiers from
// mastery, the forgiving streak, the one-click Resume target and graduation.

export const TIER_NAMES = ["Blueprint", "Frame", "Wing", "Tower", "Landmark"] as const;

export interface SchoolTier {
  tier: number;
  masteredFraction: number;
  /** Mastered fraction the next tier needs, or null at the top. */
  nextAt: number | null;
  graduations: number;
}

/** docs/02 §7.3: 0 Blueprint · 1 Frame (a class opened) · 2–4 by mastered share; 4 also needs a graduation. */
export function schoolTier(handle: DbHandle, game: GameConfig, schoolId: string): SchoolTier {
  const { sqlite } = handle;
  const rooms = sqlite
    .prepare(
      "SELECT count(*) AS n, coalesce(sum(status = 'graduated'), 0) AS g FROM classrooms WHERE school_id = ? AND status != 'archived'",
    )
    .get(schoolId) as { n: number; g: number };
  const statuses = Object.values(schoolConceptStatuses(handle, schoolId, game.status));
  const masteredFraction = statuses.length
    ? statuses.filter((s) => s.status === "mastered").length / statuses.length
    : 0;
  const [t2, t3, t4] = game.buildingTiers as [number, number, number];
  let tier = rooms.n ? 1 : 0;
  if (tier && masteredFraction >= t2) tier = 2;
  if (tier && masteredFraction >= t3) tier = 3;
  if (tier && masteredFraction >= t4 && rooms.g >= 1) tier = 4;
  const nextAt = tier === 0 ? null : tier === 1 ? t2 : tier === 2 ? t3 : tier === 3 ? t4 : null;
  return { tier, masteredFraction, nextAt, graduations: rooms.g };
}

/**
 * Recomputes and stores every School's tier (only ever upward). A School that reached tier 2–4
 * gets that tier's facade decal requested (docs/07 §1.2). Returns the changes.
 */
export function refreshTiers(
  handle: DbHandle,
  game: GameConfig,
  assets?: AssetService,
): Array<{ schoolId: string; from: number; to: number }> {
  const { sqlite } = handle;
  const schools = sqlite
    .prepare(
      "SELECT id, name, building_tier AS tier, accent_color AS accent FROM schools WHERE archived = 0",
    )
    .all() as Array<{
    id: string;
    name: string;
    tier: number;
    accent: string | null;
  }>;
  const changes: Array<{ schoolId: string; from: number; to: number }> = [];
  for (const s of schools) {
    // A wing never shrinks: new classes or forgetting don't take a tier away.
    const t = Math.max(s.tier, schoolTier(handle, game, s.id).tier);
    if (t === s.tier) continue;
    sqlite.prepare("UPDATE schools SET building_tier = ? WHERE id = ?").run(t, s.id);
    changes.push({ schoolId: s.id, from: s.tier, to: t });
    if (assets && t >= 2) requestDecal(assets, s, t);
  }
  return changes;
}

function requestDecal(
  assets: AssetService,
  s: { id: string; name: string; accent: string | null },
  tier: number,
) {
  assets.request({
    kind: "building_skin",
    prompt:
      `Seamless facade panel texture for a ${TIER_NAMES[tier]!.toLowerCase()} of an orbital academy building devoted to "${s.name}": ` +
      `satin white composite panels with graphite seams, rows of softly glowing windows, a subtle repeating motif in ${s.accent ?? "#5BE7FF"} light lines. ` +
      `Front-on, even lighting, no perspective. No text. No letters.`,
    size: "1024x1024",
    quality: "medium",
    transparent: false,
    outPx: 1024,
    ownerType: "school",
    ownerId: s.id,
  });
}

/** Latest ready decal for a School, if any. */
export function schoolDecalUrl(handle: DbHandle, schoolId: string): string | null {
  const row = handle.sqlite
    .prepare(
      "SELECT id FROM assets WHERE kind = 'building_skin' AND owner_id = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1",
    )
    .get(schoolId) as { id: string } | undefined;
  return row ? `/api/assets/${row.id}` : null;
}

// --- streak (P-3, docs/02 §7.4) ---------------------------------------------------

export interface Streak {
  /** Consecutive days with a completed period, counting today or yesterday. */
  current: number;
  best: number;
  /** Whole days since the last completed period (0 = today). */
  missedDays: number;
  taughtToday: boolean;
}

/** YYYY-MM-DD in the given zone. */
export function dayIn(tz: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

const dayNumber = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

export function streak(handle: DbHandle, game: GameConfig, now = new Date()): Streak {
  const tz = game.streak.timezone;
  const ended = handle.sqlite
    .prepare("SELECT ended_at FROM periods WHERE ended_at IS NOT NULL")
    .all() as Array<{ ended_at: string }>;
  const days = [...new Set(ended.map((r) => dayNumber(dayIn(tz, new Date(r.ended_at)))))].sort(
    (a, b) => a - b,
  );
  const today = dayNumber(dayIn(tz, now));
  let best = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i && days[i]! - days[i - 1]! === 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  const last = days.at(-1);
  const missedDays = last === undefined ? 0 : Math.max(0, today - last);
  // The streak stays alive through today: it only counts as missed once a whole day passes.
  const current = last !== undefined && missedDays <= 1 ? run : 0;
  return {
    current,
    best,
    missedDays: last === undefined ? 0 : missedDays,
    taughtToday: missedDays === 0 && last !== undefined,
  };
}

// --- resume (ADHD rule 1) -----------------------------------------------------------------

export interface ResumeTarget {
  schoolId: string;
  schoolName: string;
  classroomId: string;
  classroomName: string;
  conceptTitle: string | null;
  inProgress: boolean;
  lastAt: string;
}

/** Where you were last: the most recent period's classroom and its current concept. */
export function resumeTarget(handle: DbHandle): ResumeTarget | null {
  const row = handle.sqlite
    .prepare(
      `SELECT p.classroom_id AS classroomId, c.name AS classroomName, s.id AS schoolId, s.name AS schoolName,
         k.title AS conceptTitle, p.ended_at IS NULL AS inProgress, coalesce(p.ended_at, p.started_at) AS lastAt
       FROM periods p JOIN classrooms c ON c.id = p.classroom_id JOIN schools s ON s.id = c.school_id
       LEFT JOIN concepts k ON k.id = c.current_concept_id
       WHERE c.status = 'active' AND s.archived = 0
       ORDER BY coalesce(p.ended_at, p.started_at) DESC LIMIT 1`,
    )
    .get() as (Omit<ResumeTarget, "inProgress"> & { inProgress: number }) | undefined;
  return row ? { ...row, inProgress: row.inProgress === 1 } : null;
}

// --- graduation (P-4) -------------------------------------------------------------------------

/**
 * A Classroom graduates when every module of its School has a passed exam
 * for it. Its cadets become alumni. Returns true if it just graduated.
 */
export function checkGraduation(handle: DbHandle, classroomId: string): boolean {
  const { sqlite } = handle;
  const room = sqlite
    .prepare("SELECT school_id, status FROM classrooms WHERE id = ?")
    .get(classroomId) as { school_id: string; status: string } | undefined;
  if (!room || room.status !== "active") return false;
  const modules = sqlite
    .prepare("SELECT id FROM modules WHERE school_id = ?")
    .all(room.school_id) as Array<{ id: string }>;
  if (!modules.length) return false;
  const passed = sqlite
    .prepare(
      "SELECT DISTINCT module_id FROM exams WHERE classroom_id = ? AND status = 'done' AND class_average >= pass_threshold",
    )
    .all(classroomId) as Array<{ module_id: string }>;
  const ok = new Set(passed.map((p) => p.module_id));
  if (!modules.every((m) => ok.has(m.id))) return false;
  sqlite.transaction(() => {
    sqlite.prepare("UPDATE classrooms SET status = 'graduated' WHERE id = ?").run(classroomId);
    sqlite
      .prepare(
        "UPDATE cadets SET status = 'alumni' WHERE classroom_id = ? AND status IN ('enrolled','transferred_in')",
      )
      .run(classroomId);
  })();
  return true;
}
