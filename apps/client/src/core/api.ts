import type { PeriodKind } from "@lumen/shared";
import type { Archetype, EditableCurriculum } from "@lumen/shared";
import { SERVER_HTTP } from "./net";

// REST for the setup screens (docs/05 §6). Errors carry the server's
// plain-language message so screens can show it as is.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly problems: string[] = [],
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(SERVER_HTTP + path, {
      method,
      ...(body instanceof FormData
        ? { body }
        : body !== undefined
          ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
          : {}),
    });
  } catch {
    throw new ApiError("Can't reach the server. Start it with: pnpm dev", 0);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; problems?: string[] };
  if (!res.ok)
    throw new ApiError(json.error ?? `Request failed (${res.status})`, res.status, json.problems);
  return json as T;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body?: unknown) => call<T>("POST", path, body ?? {}),
  put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => call<T>("PATCH", path, body),
  del: <T>(path: string) => call<T>("DELETE", path),
  upload: <T>(path: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return call<T>("POST", path, form);
  },
};

export const assetSrc = (url: string | null | undefined) => (url ? SERVER_HTTP + url : null);

// --- response shapes ------------------------------------------------------------

export interface ClassroomSummary {
  id: string;
  name: string;
  status: "registering" | "active" | "graduated" | "archived";
  cadets: number;
  lastPeriodAt?: string | null;
  openPeriodElapsedMs?: number | null;
  difficulty?: string;
  /** Mean comprehension on taught concepts, 0..1 (School detail only). */
  understanding?: number | null;
  periods?: number;
}

export interface SchoolSummary {
  id: string;
  name: string;
  description: string | null;
  accent: string | null;
  emblemUrl: string | null;
  sources: number;
  concepts: number;
  classrooms: ClassroomSummary[];
}

export interface ArchivedSchool {
  id: string;
  name: string;
  accent: string | null;
  concepts: number;
  classrooms: number;
}

export interface SourceRow {
  id: string;
  title: string;
  kind: string;
  status: "queued" | "parsing" | "embedding" | "ready" | "error";
  error: string | null;
  pageCount: number | null;
  chunks: number;
}

export interface SchoolDetail {
  id: string;
  name: string;
  description: string | null;
  accent: string | null;
  emblemUrl: string | null;
  sources: SourceRow[];
  classrooms: ClassroomSummary[];
  classroomLimit: number;
}

export type ConceptStatus = "untaught" | "taught" | "weak" | "mastered";

export interface CurriculumView extends EditableCurriculum {
  /** S-5: sources added after the curriculum was built. */
  newSources: Array<{ id: string; title: string }>;
  status: Record<string, { status: ConceptStatus; comprehension: number | null; turns: number }>;
}

export interface Settings {
  profile: string;
  profiles: string[];
  monthlyUsdCap: number;
  imagesUsdCap: number;
  periodMinutes: number;
  randomEvents: boolean;
  peerTalk: boolean;
  growthArcs: boolean;
  minMinutes: number;
  maxMinutes: number;
  hasOpenAiKey: boolean;
  hasDeepSeekKey: boolean;
}

export type { Archetype };

export interface CampusView {
  wings: Array<{
    schoolId: string;
    slot: number;
    tier: number;
    tierName: string;
    masteredFraction: number;
    nextAt: number | null;
    graduations: number;
    decalUrl: string | null;
  }>;
  streak: {
    current: number;
    best: number;
    missedDays: number;
    taughtToday: boolean;
    /** V3-07: banked freezes, and missed days one covered. */
    freezes: number;
    frozenDays: number;
  };
  /** V5: teaching modes switched on. */
  modes?: PeriodKind[];
  /** V3-03: the one class to teach now, and why. */
  best: {
    classroomId: string;
    classroomName: string;
    schoolName: string;
    conceptId: string;
    conceptTitle: string;
    why: "fading" | "next" | "weak";
    reason: string;
  } | null;
  /** V2-03: the one concept a class is forgetting most (null when nothing's fading). */
  fading: {
    classroomId: string;
    classroomName: string;
    schoolName: string;
    conceptId: string;
    conceptTitle: string;
    days: number;
    was: number;
    now: number;
  } | null;
  xp: {
    total: number;
    rank: string;
    next: { name: string; minXp: number } | null;
    progress: number;
  };
  resume: {
    schoolId: string;
    schoolName: string;
    classroomId: string;
    classroomName: string;
    conceptTitle: string | null;
    inProgress: boolean;
    lastAt: string;
  } | null;
}

export interface DeskView {
  /** Share of a module that must be taught before its exam (game.yaml). */
  unlock: number;
  classroom: { id: string; name: string; schoolId: string; schoolName: string };
  cadets: number;
  modules: Array<{
    id: string;
    title: string;
    concepts: Array<{ id: string; title: string; taught: boolean }>;
    eligibility: { taught: number; total: number; fraction: number; eligible: boolean };
  }>;
  assignments: Array<{
    id: string;
    title: string;
    status: string;
    createdAt: string;
    submitted: number;
    graded: number;
  }>;
  exams: Array<{
    id: string;
    moduleId: string;
    moduleTitle: string;
    status: "generating" | "ready" | "running" | "done";
    classAverage: number | null;
    passThreshold: number;
    createdAt: string;
  }>;
}
