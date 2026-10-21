/** A point in CSS pixels within #stage. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** Screen-space points the DOM overlays attach to, written by the world each frame. */
export const anchors: { speaker: ScreenPoint | null } = { speaker: null };

/** The active 3D scene's hooks for pointer routing (core/input.ts). */
export const world: {
  /** Cadet id under a stage-pixel point, if any. */
  pick: ((x: number, y: number) => string | null) | null;
  /** Last forwarded pointer position, for hover tags. */
  pointer: ScreenPoint | null;
} = { pick: null, pointer: null };
