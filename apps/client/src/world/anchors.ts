/** A point in CSS pixels within #stage. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** Screen-space points the DOM overlays attach to, written by the world each frame. */
export const anchors: { speaker: ScreenPoint | null } = { speaker: null };

/** The campus, when it's the world on screen (lobby and School screens fly it). */
export const campusView: {
  current: import("./scenes/CampusScene").CampusScene | null;
} = { current: null };

/**
 * The exam arena while it's on screen. The exam screen may mount before the
 * scene exists, so calls made through `withArena` wait for it.
 */
export const arenaView: {
  current: import("./scenes/ArenaScene").ArenaScene | null;
  queue: Array<(a: import("./scenes/ArenaScene").ArenaScene) => void>;
} = { current: null, queue: [] };

export function withArena(fn: (a: import("./scenes/ArenaScene").ArenaScene) => void): void {
  if (arenaView.current) fn(arenaView.current);
  else arenaView.queue.push(fn);
}

export function setArena(a: import("./scenes/ArenaScene").ArenaScene | null): void {
  arenaView.current = a;
  if (a) for (const fn of arenaView.queue.splice(0)) fn(a);
  else arenaView.queue.length = 0;
}

/** Post-processing controls the scenes may use (Hyperfocus dims the bloom, a power flicker the exposure). */
export const fx: {
  setBloom: ((intensity: number) => void) | null;
  setExposure: ((exposure: number) => void) | null;
} = { setBloom: null, setExposure: null };

/** The active 3D scene's hooks for pointer routing (core/input.ts). */
export const world: {
  /** Cadet id under a stage-pixel point, if any. */
  pick: ((x: number, y: number) => string | null) | null;
  /** Last forwarded pointer position, for hover tags. */
  pointer: ScreenPoint | null;
} = { pick: null, pointer: null };
