import { createStore } from "zustand/vanilla";
import { initialClassroom, type ClassroomState } from "./classroom";
import { initialSetup, type SetupState } from "./setup";

// Shared client state. Phaser and Three both subscribe; no React (CLAUDE.md).
export interface AppState {
  route:
    | { name: "boot" }
    | {
        name: "school";
        schoolId: string;
        tab: "sources" | "curriculum" | "classes" | "knowledge";
        /** V3-04: a parked thought to start a new concept from. */
        newConcept?: string;
      }
    | { name: "registration"; classroomId: string; schoolId: string }
    | {
        name: "desk";
        classroomId: string;
        schoolId: string;
        tab: "assignments" | "exams";
        assignmentId?: string;
      }
    | { name: "exam"; examId: string; classroomId: string; schoolId: string }
    | { name: "debrief"; examId: string; classroomId: string; schoolId: string }
    | { name: "classroom"; classroomId: string }
    /** V5-10: after a module, a parent asks why their child struggled. */
    | { name: "meeting"; classroomId: string; schoolId: string }
    /** V7-06/07: charts and the teaching-style profile. */
    | { name: "progress" }
    /** V3-06: body doubling, a calm timer and the parking lot. */
    | { name: "studyhall"; schoolId?: string; conceptId?: string }
    | { name: "gallery" };
  setup: SetupState;
  /** idle = never connected (e.g. demo mode). */
  net: "idle" | "connecting" | "open" | "closed";
  classroom: ClassroomState;
  /** Hand selected with Tab (or a clicked cadet); cadet under the pointer. */
  selectedId: string | null;
  hoveredId: string | null;
  /** M0 demo: the Phaser button tints the Three mesh. */
  pings: number;
}

export const store = createStore<AppState>(() => ({
  route: { name: "boot" },
  net: "idle",
  classroom: initialClassroom(),
  setup: initialSetup(),
  selectedId: null,
  hoveredId: null,
  pings: 0,
}));
