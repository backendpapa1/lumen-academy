import { createStore } from "zustand/vanilla";
import { initialClassroom, type ClassroomState } from "./classroom";

// Shared client state. Phaser and Three both subscribe; no React (CLAUDE.md).
export interface AppState {
  route: { name: "boot" } | { name: "classroom"; classroomId: string } | { name: "gallery" };
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
  selectedId: null,
  hoveredId: null,
  pings: 0,
}));
