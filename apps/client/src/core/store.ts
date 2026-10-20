import { createStore } from "zustand/vanilla";

// Shared client state. Phaser and Three both subscribe; no React (CLAUDE.md).
export interface AppState {
  route: { name: "boot" };
  /** M0 demo: the Phaser button tints the Three mesh. */
  pings: number;
}

export const store = createStore<AppState>(() => ({
  route: { name: "boot" },
  pings: 0,
}));
