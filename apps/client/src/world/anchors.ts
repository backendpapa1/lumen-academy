/** A point in CSS pixels within #stage. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** Screen-space points the DOM overlays attach to, written by the world each frame. */
export const anchors: { speaker: ScreenPoint | null } = { speaker: null };
