/** A point in CSS pixels within #stage. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** Screen-space points the DOM overlays attach to, written by the room each frame. */
export const anchors: { speaker: ScreenPoint | null } = { speaker: null };

/** The campus, when it's on screen (the lobby points at a School's building). */
export const campusView: {
  current: import("../ui/campus/Campus").Campus | null;
} = { current: null };

/**
 * The exam hall while it's on screen. The exam screen may mount before the
 * hall exists, so calls made through `withArena` wait for it.
 */
export const arenaView: {
  current: import("../ui/room/ExamHall").ExamHall | null;
  queue: Array<(a: import("../ui/room/ExamHall").ExamHall) => void>;
} = { current: null, queue: [] };

export function withArena(fn: (a: import("../ui/room/ExamHall").ExamHall) => void): void {
  if (arenaView.current) fn(arenaView.current);
  else arenaView.queue.push(fn);
}

export function setArena(a: import("../ui/room/ExamHall").ExamHall | null): void {
  arenaView.current = a;
  if (a) for (const fn of arenaView.queue.splice(0)) fn(a);
  else arenaView.queue.length = 0;
}

/** The drawn room's hooks: who is under a point, and where the pointer is (hover tag). */
export const world: {
  /** Cadet id under a stage-pixel point, if any. */
  pick: ((x: number, y: number) => string | null) | null;
  /** Last forwarded pointer position, for hover tags. */
  pointer: ScreenPoint | null;
} = { pick: null, pointer: null };
