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
  status: Record<string, { status: ConceptStatus; comprehension: number | null; turns: number }>;
}

export interface Settings {
  profile: string;
  profiles: string[];
  monthlyUsdCap: number;
  imagesUsdCap: number;
  periodMinutes: number;
  minMinutes: number;
  maxMinutes: number;
  hasOpenAiKey: boolean;
  hasDeepSeekKey: boolean;
}

export type { Archetype };

export interface DeskView {
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
