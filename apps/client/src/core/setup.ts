import type { CadetView, ServerMessage } from "@lumen/shared";
import type { ArchivedSchool, CampusView, SchoolDetail, SchoolSummary } from "./api";

// State for the setup screens: lobby, School Wing and registration. Server
// broadcasts (source.status, curriculum.status, registration.*) are reduced
// here by a pure function, like the classroom.

export interface SourceJob {
  title: string;
  sourceId: string | null;
  status: "queued" | "parsing" | "embedding" | "ready" | "error";
  detail?: string;
}

export interface Registration {
  classroomId: string;
  schoolId: string;
  name: string;
  total: number;
  arrivals: CadetView[];
  status: "arriving" | "assembled" | "error";
  detail?: string;
}

export interface SetupState {
  schools: SchoolSummary[] | null;
  /** Schools put away; shown on the lobby's Archived shelf. */
  archived: ArchivedSchool[];
  campus: CampusView | null;
  school: SchoolDetail | null;
  /** Live indexing jobs for the open School, by title. */
  sourceJobs: Record<string, SourceJob>;
  curriculumJob: {
    schoolId: string;
    status: "building" | "ready" | "error";
    detail?: string;
  } | null;
  registration: Registration | null;
}

export const initialSetup = (): SetupState => ({
  schools: null,
  archived: [],
  campus: null,
  school: null,
  sourceJobs: {},
  curriculumJob: null,
  registration: null,
});

export function applySetupMessage(s: SetupState, m: ServerMessage): SetupState {
  switch (m.type) {
    case "source.status": {
      if (s.school && m.payload.schoolId !== s.school.id) return s;
      const { title, sourceId, status, detail } = m.payload;
      return {
        ...s,
        sourceJobs: { ...s.sourceJobs, [title]: { title, sourceId, status, detail } },
      };
    }
    case "curriculum.status":
      return { ...s, curriculumJob: m.payload };
    case "registration.started":
      return {
        ...s,
        registration: { ...m.payload, arrivals: [], status: "arriving" },
      };
    case "registration.arrival": {
      const r = s.registration;
      if (!r || r.classroomId !== m.payload.classroomId) return s;
      if (r.arrivals.some((c) => c.id === m.payload.cadet.id)) return s;
      return {
        ...s,
        registration: { ...r, total: m.payload.total, arrivals: [...r.arrivals, m.payload.cadet] },
      };
    }
    case "registration.done": {
      const r = s.registration;
      if (!r || r.classroomId !== m.payload.classroomId) return s;
      return {
        ...s,
        registration: {
          ...r,
          status: m.payload.status === "active" ? "assembled" : "error",
          detail: m.payload.detail,
        },
      };
    }
    case "asset.ready": {
      const r = s.registration;
      if (!r || m.payload.ownerType !== "cadet" || m.payload.status !== "ready") {
        // A School's emblem: refresh it where it shows.
        if (m.payload.ownerType === "school" && m.payload.status === "ready") {
          const id = m.payload.ownerId;
          return {
            ...s,
            school: s.school?.id === id ? { ...s.school, emblemUrl: m.payload.url } : s.school,
            schools:
              s.schools?.map((x) => (x.id === id ? { ...x, emblemUrl: m.payload.url } : x)) ?? null,
          };
        }
        return s;
      }
      return {
        ...s,
        registration: {
          ...r,
          arrivals: r.arrivals.map((c) =>
            c.id === m.payload.ownerId ? { ...c, portraitUrl: m.payload.url } : c,
          ),
        },
      };
    }
    default:
      return s;
  }
}
